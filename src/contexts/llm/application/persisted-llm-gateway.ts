import { z } from "zod";
import { createHash } from "crypto";
import { uuidFromStableKey } from "../../shared/stable-id";
import {
  LlmEvaluationRecord,
  LlmEvaluationRepository,
  LlmEvaluationRequest,
  LlmProviderResult
} from "./llm-evaluation";

export type LlmProvider = (request: LlmEvaluationRequest) => Promise<LlmProviderResult>;

export class PersistedLlmGateway {
  constructor(
    private readonly repository: LlmEvaluationRepository,
    private readonly provider: LlmProvider
  ) {}

  async evaluate(request: LlmEvaluationRequest): Promise<LlmEvaluationRecord> {
    const inputHash = hashInput(request.input);
    const cached = await this.repository.findCached(request, inputHash);
    if (cached) return cached;

    const startedAt = Date.now();
    try {
      const result = await this.provider(request);
      const parsedOutput = validateOutput(request, result.output);
      const record: LlmEvaluationRecord = {
        ...request,
        id: uuidFromStableKey(`${request.taskType}:${request.promptVersion}:${request.model}:${inputHash}`),
        inputHash,
        output: result.output,
        parsedOutput,
        status: parsedOutput ? "succeeded" : "failed",
        promptTokens: result.tokenUsage?.promptTokens ?? 0,
        completionTokens: result.tokenUsage?.completionTokens ?? 0,
        estimatedCostUsd: 0,
        latencyMs: result.latencyMs ?? Date.now() - startedAt,
        createdAt: new Date(startedAt).toISOString()
      };
      await this.repository.save(record);
      return record;
    } catch (error) {
      const record: LlmEvaluationRecord = {
        ...request,
        id: uuidFromStableKey(`${request.taskType}:${request.promptVersion}:${request.model}:${inputHash}:failed`),
        inputHash,
        output: { error: String(error) },
        status: "failed",
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostUsd: 0,
        latencyMs: Date.now() - startedAt,
        createdAt: new Date(startedAt).toISOString()
      };
      await this.repository.save(record);
      return record;
    }
  }
}

function hashInput(input: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}


function validateOutput(
  request: LlmEvaluationRequest,
  output: Record<string, unknown>
): Record<string, unknown> | undefined {
  const schema = schemaForTask(request.taskType);
  const parsed = schema.safeParse(output);
  return parsed.success ? parsed.data : undefined;
}

function schemaForTask(taskType: LlmEvaluationRequest["taskType"]): z.ZodType<Record<string, unknown>> {
  if (taskType === "market_equivalence") {
    return z.object({
      equivalent: z.boolean(),
      confidence: z.number().min(0).max(1),
      explanation: z.string().min(1)
    }).strict();
  }

  if (taskType === "market_normalization") {
    return z.object({
      topic: z.string().min(1),
      eventType: z.string().min(1),
      confidence: z.number().min(0).max(1),
      ambiguityFlags: z.array(z.string())
    }).strict();
  }

  if (taskType === "adversarial_critique") {
    return z.object({
      accepted: z.boolean(),
      explanation: z.string().min(1)
    }).strict().or(z.object({
      refuted: z.boolean(),
      explanation: z.string().min(1)
    }).strict());
  }

  return z.object({
    explanation: z.string().min(1)
  }).strict();
}

