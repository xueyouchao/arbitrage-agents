import { PayoffType, Venue } from "../../matching/domain/normalized-market";
import {
	evaluateExitGate,
	ExitGateConfig,
	ExitGateResult,
} from "./exit-gate-evaluator";
import {
	BasisRiskClass,
	ContractSide,
	CrossVenueOpportunity,
	ExitPolicy,
	GateResult,
	PriceLevel,
	RiskStructure,
} from "./opportunity";

// ADR-0002 §3.5: alert-first t1 exit record. Phase 1 is observable only — NO orders are placed.
export interface T1ExitAlert {
	opportunityId: string;
	pairId: string;
	// ADR §3.2: the timer fires at the early leg's deadline.
	triggerAt: string;
	// Leg that settles first (kept so the evaluator can reconstruct the RiskStructure).
	earlyLeg: { venue: Venue; marketId: string; side: ContractSide; deadline?: string };
	// The surviving leg that would be sold at t1.
	survivingLeg: { venue: Venue; marketId: string; side: ContractSide };
	exitPolicy: ExitPolicy;
	basisRiskClass: BasisRiskClass;
	dtHours: number;
	payoffType: PayoffType;
	// Populated only after evaluateT1ExitAlert runs; absent until then.
	gateResult?: GateResult;
	recommendedSellPrice?: number;
	recommendedSellSize?: number;
	lockValue?: number;
	holdExpectedValue?: number;
	exitCost?: number;
	reasoning?: string;
}

// ADR-0002 §3.5: build alert records from opportunities marked for t1 evaluation.
// Pure: no timers, no book fetching, no trading-client calls.
export function buildT1ExitAlerts(opportunities: CrossVenueOpportunity[]): T1ExitAlert[] {
	const alerts: T1ExitAlert[] = [];
	for (const opp of opportunities) {
		if (!opp.riskStructure) continue;
		// ADR-0002 §3.4: only sequential-settlement opportunities (exitPolicy
		// "evaluate") get a t1 alert. "hold" (simultaneous settlement) does not.
		if (opp.riskStructure.exitPolicy !== "evaluate") continue;

		alerts.push({
			opportunityId: opp.id,
			pairId: opp.pairId,
			triggerAt: opp.riskStructure.earlyLeg.deadline ?? "",
			earlyLeg: opp.riskStructure.earlyLeg,
			survivingLeg: opp.riskStructure.survivingLeg,
			exitPolicy: opp.riskStructure.exitPolicy,
			basisRiskClass: opp.riskStructure.basisRiskClass,
			dtHours: opp.riskStructure.dtHours,
			payoffType: opp.riskStructure.payoffType,
		});
	}
	return alerts;
}

// ADR-0002 §3.6: apply a t1 book snapshot + gate evaluation to produce an auditable alert.
// Returns a NEW alert with gate fields populated.
export function evaluateT1ExitAlert(
	alert: T1ExitAlert,
	survivingLegBook: {
		marketId: string;
		side: ContractSide;
		bidPrice: number;
		askPrice: number;
		depth: PriceLevel[];
	},
	positionSize: number,
	config?: Partial<ExitGateConfig>,
): T1ExitAlert {
	// Defensive guard: the book snapshot must be for the alert's surviving leg.
	// A mismatch is a caller wiring bug; fail the gate loudly rather than
	// silently evaluating the wrong market's book.
	if (survivingLegBook.marketId !== alert.survivingLeg.marketId) {
		return {
			...alert,
			gateResult: "fail",
			recommendedSellPrice: 0,
			recommendedSellSize: 0,
			lockValue: 0,
			holdExpectedValue: 0,
			exitCost: 0,
			reasoning: `marketId mismatch: book=${survivingLegBook.marketId} survivingLeg=${alert.survivingLeg.marketId} → FAIL`,
		};
	}

	const riskStructure: RiskStructure = {
		earlyLeg: alert.earlyLeg,
		survivingLeg: alert.survivingLeg,
		dtHours: alert.dtHours,
		basisRiskClass: alert.basisRiskClass,
		payoffType: alert.payoffType,
		exitPolicy: alert.exitPolicy,
	};

	const result: ExitGateResult = evaluateExitGate({
		riskStructure,
		survivingLegBook,
		positionSize,
		config,
	});

	return {
		...alert,
		gateResult: result.gateResult,
		recommendedSellPrice: result.recommendedSellPrice,
		recommendedSellSize: result.recommendedSellSize,
		lockValue: result.lockValue,
		holdExpectedValue: result.holdExpectedValue,
		exitCost: result.exitCost,
		reasoning: result.reasoning,
	};
}

// ADR-0002 §3.2: in-memory registry of pending t1 triggers keyed by opportunityId.
// Phase-1 stub — no actual timers fire; Postgres-backed resumable scan state is T6/T7.
export class T1TriggerRegistry {
	private readonly alerts = new Map<string, T1ExitAlert>();

	// Register a fresh (detection-time) opportunity: builds and stores its pending
	// alert. Opportunities without a riskStructure or with exitPolicy "hold" are
	// silently skipped (they have no t1 trigger).
	registerOpportunity(opportunity: CrossVenueOpportunity): void {
		const built = buildT1ExitAlerts([opportunity]);
		if (built.length === 0) return;
		this.alerts.set(built[0].opportunityId, built[0]);
	}

	// Register an alert directly (typically the result of evaluateT1ExitAlert,
	// which carries the populated gate fields). Overwrites any prior alert for
	// the same opportunityId. Separate from registerOpportunity so the compiler
	// enforces which shape a caller is providing — no silent CrossVenueOpportunity/
	// T1ExitAlert confusion at the call site.
	registerAlert(alert: T1ExitAlert): void {
		this.alerts.set(alert.opportunityId, alert);
	}

	pending(): ReadonlyArray<T1ExitAlert> {
		return Array.from(this.alerts.values()).filter((a) => a.gateResult === undefined);
	}

	evaluated(): ReadonlyArray<T1ExitAlert> {
		return Array.from(this.alerts.values()).filter((a) => a.gateResult !== undefined);
	}

	clear(): void {
		this.alerts.clear();
	}
}
