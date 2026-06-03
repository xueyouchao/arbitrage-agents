import { LlmEvaluationRecord, LlmEvaluationRepository, LlmEvaluationRequest } from "./llm-evaluation";

export class InMemoryLlmEvaluationRepository implements LlmEvaluationRepository {
  readonly records: LlmEvaluationRecord[] = [];

  findCached(request: LlmEvaluationRequest, inputHash: string): Promise<LlmEvaluationRecord | undefined> {
    return Promise.resolve(
      this.records.find(
        (record) =>
          record.taskType === request.taskType &&
          record.promptVersion === request.promptVersion &&
          record.model === request.model &&
          record.inputHash === inputHash &&
          record.status === "succeeded"
      )
    );
  }

  save(record: LlmEvaluationRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }
}
