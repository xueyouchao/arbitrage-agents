import {
  describe,
  it,
  expect,
} from "vitest";
import {
  evaluateExitGate,
  DEFAULT_EXIT_GATE_CONFIG,
  ExitGateInput,
} from "../src/contexts/arbitrage/domain/exit-gate-evaluator";
import { RiskStructure } from "../src/contexts/arbitrage/domain/opportunity";

const defaultRiskStructure = (dtHours: number): RiskStructure => ({
  earlyLeg: { venue: "kalshi", marketId: "early-1", side: "YES" },
  survivingLeg: { venue: "polymarket", marketId: "surv-1", side: "YES" },
  dtHours,
  basisRiskClass: "same_ref",
  payoffType: "at_time",
  exitPolicy: "evaluate",
});

const baseBook = {
  marketId: "surv-1",
  side: "YES" as const,
  bidPrice: 0.95,
  askPrice: 0.97,
  depth: [{ price: 0.95, size: 500 }],
};

const baseInput = (overrides: Partial<ExitGateInput> = {}): ExitGateInput => ({
  riskStructure: defaultRiskStructure(4),
  survivingLegBook: baseBook,
  positionSize: 100,
  ...overrides,
});

describe("evaluateExitGate", () => {
  it("passes the exit-cost and liquidity gates with a clear edge", () => {
    const result = evaluateExitGate(baseInput());
    // mid = (0.95 + 0.97) / 2 = 0.96
    // gapDecay = clamp(4 * 0.02, 0, 0.5) = 0.08
    // holdEV per share = 0.96 * (1 - 0.08) = 0.8832
    // exitCost per share = 0.95 * (0.01 + 0.01) + 0.005 = 0.019 + 0.005 = 0.024
    //   (fee + spread scale with price; slippage is a per-share cost proportional to size)
    // lockPerShare = 0.95
    // margin = 0.95 - 0.8832 = 0.0668
    // threshold = 0.024 + 0.005 = 0.029
    // margin > threshold → pass
    expect(result.gateResult).toBe("pass");
    expect(result.recommendedSellPrice).toBe(0.95);
    expect(result.recommendedSellSize).toBe(100);
    expect(result.lockValue).toBe(0.95 * 100);
    expect(result.holdExpectedValue).toBeCloseTo(0.8832, 6);
    expect(result.exitCost).toBeCloseTo(0.024, 6);
    expect(result.reasoning).toContain("exit-cost gate");
    expect(result.reasoning).toContain("liquidity gate");
    expect(result.reasoning).toContain("PASS");
  });

  it("fails the exit-cost gate when fees blow out the edge", () => {
    const result = evaluateExitGate(
      baseInput({ config: { sellFeeRate: 0.5 } }),
    );
    // exitCost per share = 0.95 * (0.5 + 0.01) + 0.005 = 0.4845
    // threshold = 0.4845 + 0.005 = 0.4895
    // margin = 0.0668 < threshold → fail
    expect(result.gateResult).toBe("fail");
    expect(result.reasoning).toContain("exit-cost gate");
    expect(result.reasoning).toContain("FAIL");
  });

  it("fails the liquidity gate when no depth exists", () => {
    const result = evaluateExitGate(
      baseInput({
        survivingLegBook: {
          ...baseBook,
          depth: [],
        },
      }),
    );
    expect(result.gateResult).toBe("fail");
    expect(result.recommendedSellSize).toBe(0);
    expect(result.lockValue).toBe(0);
    expect(result.reasoning).toContain("no liquidity");
  });

  it("caps sell size by the liquidity haircut", () => {
    const result = evaluateExitGate(
      baseInput({
        survivingLegBook: {
          ...baseBook,
          depth: [{ price: 0.95, size: 200 }],
        },
      }),
    );
    // availableDepth = 200, haircut = 0.25, cap = 50
    // positionSize = 100 → capped to 50
    expect(result.recommendedSellSize).toBe(50);
    expect(result.lockValue).toBe(0.95 * 50);
    expect(result.gateResult).toBe("pass");
  });

  it("sums cumulative depth across the book ladder (ADR §3.3)", () => {
    const result = evaluateExitGate(
      baseInput({
        survivingLegBook: {
          ...baseBook,
          // best level only 200 (would cap at 50), but cumulative 800 caps at 200.
          depth: [
            { price: 0.95, size: 200 },
            { price: 0.945, size: 300 },
            { price: 0.94, size: 300 },
          ],
        },
      }),
    );
    // cumulativeDepth = 200 + 300 + 300 = 800, haircut = 0.25, cap = 200
    // positionSize = 100 → not capped (100 < 200) → sell full 100
    expect(result.recommendedSellSize).toBe(100);
    expect(result.gateResult).toBe("pass");
  });

  it("fails the gate when book prices are invalid (NaN guard)", () => {
    const result = evaluateExitGate(
      baseInput({
        survivingLegBook: {
          ...baseBook,
          bidPrice: NaN,
        },
      }),
    );
    expect(result.gateResult).toBe("fail");
    expect(result.recommendedSellSize).toBe(0);
    expect(result.reasoning).toContain("invalid");
  });

  it("fails when minMargin override requires a larger edge than available", () => {
    const result = evaluateExitGate(
      baseInput({ config: { minMargin: 0.5 } }),
    );
    // margin = 0.0668 < 0.5 + exitCost → fail
    expect(result.gateResult).toBe("fail");
    expect(result.reasoning).toContain("minMargin=0.5");
    expect(result.reasoning).toContain("FAIL");
  });
});
