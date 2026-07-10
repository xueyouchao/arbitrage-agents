import { ContractSide, RiskStructure, BasisRiskClass, ExitPolicy } from "./opportunity";
import { PayoffType, Venue } from "../../matching/domain/normalized-market";

// ADR-0002 §3.4: classify a two-leg opportunity for conditional settlement exit.
// Sequential settlement (Δt > 0) may be evaluated for t1 exit; simultaneous
// settlement (Δt ≈ 0) is held to t2. The surviving leg's payoff type is kept
// for the exit model. Basis-risk class follows the resolution-source comparison.
export interface RiskStructureInput {
	// The two legs of the opportunity. Each carries deadline + resolutionSource + payoffType + venue/marketId/side.
	legA: {
		venue: Venue;
		marketId: string;
		side: ContractSide;
		deadline?: string;
		resolutionSource?: string;
		payoffType: PayoffType;
	};
	legB: {
		venue: Venue;
		marketId: string;
		side: ContractSide;
		deadline?: string;
		resolutionSource?: string;
		payoffType: PayoffType;
	};
}

// Mirrors equivalence-policy.ts behavior: trim, lowercase, and collapse empties
// to undefined so missing sources are detected consistently.
function normalizeResolutionSource(source?: string): string | undefined {
	const normalized = source?.trim().toLowerCase();
	return normalized && normalized.length > 0 ? normalized : undefined;
}

function parseDeadlineMs(deadline?: string): number | undefined {
	if (!deadline) return undefined;
	const ms = new Date(deadline).getTime();
	return Number.isFinite(ms) ? ms : undefined;
}

function roundToDecimals(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

// The classifier rounds dtHours to 3 decimals, so the smallest non-zero gap that
// survives rounding is ~0.001h ≈ 3.6s. Any smaller deadline difference is treated
// as simultaneous settlement (hold), which is the intended float-dust behavior.
const MIN_SEQUENTIAL_GAP_HOURS = 0.001;

export function classifyRiskStructure(input: RiskStructureInput): RiskStructure {
	const timeA = parseDeadlineMs(input.legA.deadline);
	const timeB = parseDeadlineMs(input.legB.deadline);

	// ADR-0002 §3.4: conservative fallback on bad/missing deadline data.
	// If either deadline is missing or invalid, treat Δt as 0 → simultaneous → hold.
	let dtHours = 0;
	if (timeA !== undefined && timeB !== undefined) {
		dtHours = roundToDecimals(Math.abs(timeA - timeB) / 3_600_000, 3);
	}

	// ADR-0002 §3.4: early leg = earlier deadline. Tie-break by input order so
	// the result is deterministic and independent of sort instability.
	let earlyLeg = input.legA;
	let survivingLeg = input.legB;
	if (timeA !== undefined && timeB !== undefined && timeB < timeA) {
		earlyLeg = input.legB;
		survivingLeg = input.legA;
	}

	// ADR-0002 §3.6: same non-empty normalized resolution source ⇒ same_ref;
	// anything else (different or missing) ⇒ diff_ref.
	const sourceA = normalizeResolutionSource(input.legA.resolutionSource);
	const sourceB = normalizeResolutionSource(input.legB.resolutionSource);
	let basisRiskClass: BasisRiskClass = "diff_ref";
	if (sourceA && sourceA === sourceB) {
		basisRiskClass = "same_ref";
	}

	// ADR-0002 §3.4: sequential settlement (evaluate) starts once the rounded gap
	// clears the minimum meaningful threshold; smaller deltas are treated as
	// simultaneous settlement (hold) to ignore timestamp dust.
	const exitPolicy: ExitPolicy = dtHours >= MIN_SEQUENTIAL_GAP_HOURS ? "evaluate" : "hold";

	return {
		earlyLeg: {
			venue: earlyLeg.venue,
			marketId: earlyLeg.marketId,
			side: earlyLeg.side,
			deadline: earlyLeg.deadline,
		},
		survivingLeg: {
			venue: survivingLeg.venue,
			marketId: survivingLeg.marketId,
			side: survivingLeg.side,
			deadline: survivingLeg.deadline,
		},
		dtHours,
		basisRiskClass,
		payoffType: survivingLeg.payoffType,
		exitPolicy,
	};
}
