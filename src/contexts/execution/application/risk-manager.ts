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
   *
   * @throws {RangeError} when any input is negative or NaN.
   */
  checkExecution(totalOpenNotional: number, requestedNotional: number, maxCapitalDeployed: number): boolean {
    if (!Number.isFinite(totalOpenNotional) || totalOpenNotional < 0) {
      throw new RangeError(`totalOpenNotional must be a non-negative finite number, got: ${totalOpenNotional}`);
    }
    if (!Number.isFinite(requestedNotional) || requestedNotional < 0) {
      throw new RangeError(`requestedNotional must be a non-negative finite number, got: ${requestedNotional}`);
    }
    if (!Number.isFinite(maxCapitalDeployed) || maxCapitalDeployed < 0) {
      throw new RangeError(`maxCapitalDeployed must be a non-negative finite number, got: ${maxCapitalDeployed}`);
    }
    return totalOpenNotional + requestedNotional <= maxCapitalDeployed;
  }
}