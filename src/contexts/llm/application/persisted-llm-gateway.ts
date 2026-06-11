import { z } from "zod";
import { createHash } from "crypto";
import { redactSensitiveText } from "../../../config/redaction";
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
        id: uuidFromStableKey(`${request.taskType}:${request.promptVersion}:${request.model}:${inputHash}`),
        inputHash,
        output: { error: sanitizeProviderError(error) },
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

function sanitizeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message)
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/token[_-]?id=[^\s&]+/gi, "token_id=[redacted]")
    .replace(/(["'])(api[_-]?key|apiKey|private[_-]?key|privateKey|authorization|auth[_-]?header|authHeader|password|secret|token|access[_-]?token|accessToken|refresh[_-]?token|refreshToken)\1\s*:\s*(["']).*?\3/gi, "$1$2$1:$3[REDACTED]$3")
    .replace(/(api[_-]?key|apiKey|private[_-]?key|privateKey|authorization|auth[_-]?header|authHeader|password|secret|token|access[_-]?token|accessToken|refresh[_-]?token|refreshToken)(\s*[:=]\s*)[^\s,;}&]+/gi, "$1$2[REDACTED]")
    .slice(0, 200);
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
      topic: z.enum(["crypto", "macro"]),
      eventType: z.enum(["price_above", "price_below", "fed_rate_decision", "cpi_range"]),
      asset: z.enum(["BTC", "ETH"]).nullable(),
      threshold: z.number().nullable(),
      operator: z.enum([">", ">=", "<", "<=", "=", "between"]).nullable(),
      deadline: z.string().datetime().nullable(),
      timezone: z.string().min(1).nullable(),
      resolutionSource: z.string().min(1).nullable(),
      payoffType: z.enum(["at_time", "any_time_before", "range", "settlement_value"]),
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
