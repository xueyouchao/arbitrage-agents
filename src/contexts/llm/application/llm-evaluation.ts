export interface LlmEvaluationRequest {
  taskType: "market_normalization" | "market_equivalence" | "adversarial_critique" | "explanation";
  promptVersion: string;
  model: string;
  input: Record<string, unknown>;
}

export interface LlmProviderResult {
  output: Record<string, unknown>;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
  };
  latencyMs?: number;
}

export interface LlmEvaluationRecord extends LlmEvaluationRequest {
  id: string;
  inputHash: string;
  output?: Record<string, unknown>;
  parsedOutput?: Record<string, unknown>;
  status: "succeeded" | "failed";
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  createdAt: string;
}

export interface LlmEvaluationRepository {
  findCached(request: LlmEvaluationRequest, inputHash: string): Promise<LlmEvaluationRecord | undefined>;
  save(record: LlmEvaluationRecord): Promise<void>;
}
