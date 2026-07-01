/**
 * Pre-trade risk guard for the execution context (issue #81).
 *
 * Single guard: max capital deployed across all open positions. If
 * `totalOpenNotional + requestedNotional` exceeds `maxCapitalDeployed`,
 * the execution is rejected. No other limits — by design.
 */
export class RiskManager {
  /**
   * Returns `true` when the execution may proceed, `false` when it would
   * breach the max-capital-deployed limit.
   */
  checkExecution(totalOpenNotional: number, requestedNotional: number, maxCapitalDeployed: number): boolean {
    return totalOpenNotional + requestedNotional <= maxCapitalDeployed;
  }
}