import {
  RouterValueEvaluationResult,
  RouterValueEvaluationRepository,
} from "./pmxt-router-value-evaluator";

export class InMemoryRouterValueEvaluationRepository
  implements RouterValueEvaluationRepository
{
  readonly evaluations: RouterValueEvaluationResult[] = [];

  async saveEvaluation(result: RouterValueEvaluationResult): Promise<void> {
    this.evaluations.push(result);
  }
}
