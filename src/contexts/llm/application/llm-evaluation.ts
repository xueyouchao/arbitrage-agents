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
  /**
   * Schema version stamped on the parsed output by the gateway. Callers can
   * scope cache lookups by `payloadSchemaVersion` so that pre-existing cache
   * rows in an older shape are not silently trusted against a newer
   * downstream schema (issue #12).
   */
  payloadSchemaVersion?: string;
  /**
   * True when the record was returned from the repository cache rather than a
   * fresh provider call. Callers MUST NOT count cached rows against per-scan
   * budgets or accumulate their token / latency metrics, otherwise a single
   * popular input can exhaust the scan cap without producing new work
   * (issue #6).
   */
  isCacheHit?: boolean;
  /**
   * True when the gateway persisted this evaluation to its repository. The
   * scanner MUST NOT link to evaluations that were not persisted, otherwise
   * the foreign-key drop leaves a dangling audit reference that silently
   * breaks downstream joins.
   */
  isPersisted?: boolean;
}

export interface LlmEvaluationRepository {
  findCached(request: LlmEvaluationRequest, inputHash: string): Promise<LlmEvaluationRecord | undefined>;
  save(record: LlmEvaluationRecord): Promise<void>;
}
