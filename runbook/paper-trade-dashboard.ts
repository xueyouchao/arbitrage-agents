import { PaperTradeSimulation } from "../src/contexts/arbitrage/domain/paper-trade-simulator";
import { NotionalEdge } from "../src/contexts/arbitrage/domain/opportunity";
import { OpportunityReadModel } from "../src/contexts/api/read-models";

export interface PaperTradeComparisonRow {
  targetNotionalUsd: number;
  /** Edge advertised by the opportunity calculator for this notional (theoretical/optimistic). */
  apparentEdge: number;
  /** Edge realized by the paper-trade simulator after fills, fees, slippage, and adverse selection. */
  actionableEdge: number;
  /** Difference between apparent and actionable edge, in decimal points. */
  edgeLeakage: number;
  /** Expected PnL if the target notional were fully executed at the actionable edge. */
  expectedPnlUsd: number;
  /** Combined fees across both legs. */
  totalFees: number;
  /** Combined slippage across both legs. */
  totalSlippage: number;
  /** Unfilled notional when the book could not absorb the target. */
  residualExposureUsd: number;
  /** True when the paper trade could not fully fill the target notional. */
  partialFill: boolean;
  /** True when the simulation is fillable and has a non-negative net edge. */
  actionable: boolean;
  /** Opportunity-level net edge (at executable size) for reference. */
  opportunityNetEdge: number;
}

export interface PaperTradeComparisonSummary {
  executableSizeUsd: number;
  bestActionableNotionalUsd: number | undefined;
  bestActionableEdge: number | undefined;
  worstEdgeLeakageBps: number | undefined;
  averageEdgeLeakageBps: number | undefined;
}

export interface PaperTradeComparisonResult {
  opportunityId: string;
  pairId: string;
  detectedAt: string;
  calculationVersion: string;
  configVersion: string;
  rows: PaperTradeComparisonRow[];
  summary?: PaperTradeComparisonSummary;
}

export interface PaperTradeDashboardOptions {
  /** Minimum actionable edge required for a row to count as actionable. Default: 0 */
  minActionableEdge?: number;
}

/**
 * Dashboard / runbook helper that compares the edge advertised by the
 * opportunity calculator (`apparentEdge`) with the edge produced by the
 * deterministic paper-trade simulator (`actionableEdge`) for each target
 * notional. Use it in runbooks, acceptance tests, or ad-hoc analysis.
 */
export class PaperTradeDashboard {
  constructor(private readonly options: PaperTradeDashboardOptions = {}) {}

  compare(opportunity: OpportunityReadModel, simulations: PaperTradeSimulation[]): PaperTradeComparisonResult {
    const minActionableEdge = this.options.minActionableEdge ?? 0;
    const edgesByNotional = new Map<number, NotionalEdge>();
    for (const edge of opportunity.notionalEdges) {
      if (Number.isFinite(edge.targetNotionalUsd)) {
        edgesByNotional.set(edge.targetNotionalUsd, edge);
      }
    }

    const rows = simulations
      .filter((sim) => Number.isFinite(sim.targetNotionalUsd))
      .map((sim) => {
        const edge = edgesByNotional.get(sim.targetNotionalUsd);
        const apparentEdge = edge?.netEdge ?? opportunity.executableNetEdge ?? opportunity.netEdge;
        const totalFees = round4(sim.longLegFill.fees + sim.hedgeLegFill.fees);
        const totalSlippage = round4(sim.longLegFill.slippage + sim.hedgeLegFill.slippage);
        const actionable = !sim.partialFill && sim.netEdge >= minActionableEdge;
        const row: PaperTradeComparisonRow = {
          targetNotionalUsd: sim.targetNotionalUsd,
          apparentEdge: round4(apparentEdge),
          actionableEdge: round4(sim.netEdge),
          edgeLeakage: round4(apparentEdge - sim.netEdge),
          expectedPnlUsd: roundUsd(sim.targetNotionalUsd * sim.netEdge),
          totalFees,
          totalSlippage,
          residualExposureUsd: roundUsd(sim.residualExposureUsd),
          partialFill: sim.partialFill,
          actionable,
          opportunityNetEdge: round4(opportunity.executableNetEdge ?? opportunity.netEdge)
        };
        return row;
      })
      .sort((a, b) => a.targetNotionalUsd - b.targetNotionalUsd);

    const summary = rows.length > 0 ? buildSummary(opportunity, rows) : undefined;

    return {
      opportunityId: opportunity.id,
      pairId: opportunity.pairId,
      detectedAt: opportunity.detectedAt,
      calculationVersion: opportunity.calculationVersion,
      configVersion: opportunity.configVersion,
      rows,
      summary
    };
  }

  render(opportunity: OpportunityReadModel, simulations: PaperTradeSimulation[]): string {
    const result = this.compare(opportunity, simulations);
    const lines: string[] = [];
    lines.push(`Opportunity ${result.opportunityId} (pair ${result.pairId})`);
    lines.push(`Detected: ${result.detectedAt}  versions: ${result.calculationVersion} / ${result.configVersion}`);
    lines.push("");

    if (result.rows.length === 0) {
      lines.push("No paper-trade simulations available for this opportunity.");
      return lines.join("\n");
    }

    const col = (text: string | number, width: number) => String(text).padStart(width);
    lines.push(
      col("notional", 10) +
        col("apparentEdge", 14) +
        col("actionableEdge", 16) +
        col("leakage", 10) +
        col("expPnlUsd", 12) +
        col("fees", 10) +
        col("slippage", 10) +
        col("residual", 10) +
        col("partial", 8) +
        col("actionable", 11)
    );
    lines.push("-".repeat(101));

    for (const row of result.rows) {
      lines.push(
        col(row.targetNotionalUsd.toFixed(2), 10) +
          col(row.apparentEdge.toFixed(4), 14) +
          col(row.actionableEdge.toFixed(4), 16) +
          col(row.edgeLeakage.toFixed(4), 10) +
          col(row.expectedPnlUsd.toFixed(2), 12) +
          col(row.totalFees.toFixed(4), 10) +
          col(row.totalSlippage.toFixed(4), 10) +
          col(row.residualExposureUsd.toFixed(2), 10) +
          col(row.partialFill ? "yes" : "no", 8) +
          col(row.actionable ? "yes" : "no", 11)
      );
    }

    if (result.summary) {
      lines.push("");
      lines.push(`executableSizeUsd: ${result.summary.executableSizeUsd.toFixed(2)}`);
      if (result.summary.bestActionableNotionalUsd !== undefined) {
        lines.push(
          `bestActionableNotionalUsd: ${result.summary.bestActionableNotionalUsd.toFixed(2)} @ edge ${result.summary.bestActionableEdge?.toFixed(4)}`
        );
      }
      if (result.summary.worstEdgeLeakageBps !== undefined) {
        lines.push(`worstEdgeLeakageBps: ${result.summary.worstEdgeLeakageBps.toFixed(1)}`);
      }
    }

    return lines.join("\n");
  }
}

function buildSummary(opportunity: OpportunityReadModel, rows: PaperTradeComparisonRow[]): PaperTradeComparisonSummary {
  const actionableRows = rows.filter((r) => r.actionable);
  const bestActionable = actionableRows.length > 0
    ? actionableRows.reduce((best, current) => (current.actionableEdge > best.actionableEdge ? current : best), actionableRows[0])
    : undefined;

  const leakagesBps = rows
    .map((r) => r.edgeLeakage * 10_000)
    .filter((v) => Number.isFinite(v));
  const worstEdgeLeakageBps = leakagesBps.length > 0 ? Math.max(...leakagesBps) : undefined;
  const averageEdgeLeakageBps = leakagesBps.length > 0 ? leakagesBps.reduce((a, b) => a + b, 0) / leakagesBps.length : undefined;

  return {
    executableSizeUsd: roundUsd(opportunity.executableSizeUsd ?? opportunity.maxTradableUsd),
    bestActionableNotionalUsd: bestActionable?.targetNotionalUsd,
    bestActionableEdge: bestActionable ? round4(bestActionable.actionableEdge) : undefined,
    worstEdgeLeakageBps: worstEdgeLeakageBps !== undefined ? round1(worstEdgeLeakageBps) : undefined,
    averageEdgeLeakageBps: averageEdgeLeakageBps !== undefined ? round1(averageEdgeLeakageBps) : undefined
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
