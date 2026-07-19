import {
  RouterValueEvaluationResult,
  RouterValueEvaluationRepository,
} from "./pmxt-router-value-evaluator";

/**
 * In-memory test double for RouterValueEvaluationRepository.
 * Each test creates a fresh instance, so no eviction or cap is needed.
 * Call `clear()` between test cases when reusing a single instance.
 */
export class InMemoryRouterValueEvaluationRepository
  implements RouterValueEvaluationRepository
{
  readonly evaluations: RouterValueEvaluationResult[] = [];

  async saveEvaluation(result: RouterValueEvaluationResult): Promise<void> {
    this.evaluations.push(result);
  }

  clear(): void {
    this.evaluations.length = 0;
  }
}
