import { z, ZodType } from "zod";
import { createHash } from "crypto";
import { redactSensitiveText } from "../../../config/redaction";
import { uuidFromStableKey } from "../../shared/stable-id";
import {
  LlmEvaluationRecord,
  LlmEvaluationRepository,
  LlmEvaluationRequest,
  LlmProviderResult
} from "./llm-evaluation";
import { LlmCostCalculator } from "./llm-cost-calculator";
import { LlmOutputValidatorRegistry } from "./llm-output-validators";
import { LlmTraceReporter } from "./llm-trace-reporter";

export type LlmProvider = (request: LlmEvaluationRequest) => Promise<LlmProviderResult>;

export interface PersistedLlmGatewayOptions {
  /**
   * Validator registry mapping each task type to its current schema and
   * schema version. Domains (e.g. the scanner) own their own schemas and
   * pass them in here, instead of leaking domain knowledge into the
   * generic persisted gateway (issue #14).
   */
  validatorRegistry?: LlmOutputValidatorRegistry;
  /**
   * Optional cost calculator. When provided, each evaluation record is
   * stamped with an estimatedCostUsd computed from its token counts and
   * model pricing. Omit for backward-compatible behaviour (cost = 0).
   */
  costCalculator?: LlmCostCalculator;
  /**
   * Optional trace reporter. When provided, the gateway emits a trace
   * event after every evaluation (fresh, cached, or failed) so that
   * observability backends can record spans and metrics.
   */
  traceReporter?: LlmTraceReporter;
}

export class PersistedLlmGateway {
  private readonly registry: LlmOutputValidatorRegistry;
  private readonly costCalculator?: LlmCostCalculator;
  private readonly traceReporter?: LlmTraceReporter;

  constructor(
    private readonly repository: LlmEvaluationRepository,
    private readonly provider: LlmProvider,
    options: PersistedLlmGatewayOptions = {}
  ) {
    this.registry = options.validatorRegistry ?? defaultValidatorRegistry();
    this.costCalculator = options.costCalculator;
    this.traceReporter = options.traceReporter;
  }

  async evaluate(request: LlmEvaluationRequest): Promise<LlmEvaluationRecord> {
    const inputHash = hashInput(request.input);
    const cached = await this.repository.findCached(request, inputHash);
    if (cached) {
      // Issue #6: distinguish cached vs fresh. The cached record must still
      // be returned for downstream use, but it must not be counted as a
      // fresh evaluation by callers.
      //
      // Issue #12: cached records are re-validated against the current
      // schema and stamped with the current payloadSchemaVersion.
      // Pre-existing succeeded cache rows that no longer validate against
      // the current schema are downgraded to failed and a fresh provider
      // call is attempted.
      const revalidated = revalidateCachedOutput(cached, this.registry, request);
      if (revalidated.status === "succeeded" && revalidated.parsedOutput) {
        const cacheHit = { ...revalidated, isCacheHit: true };
        try {
          this.traceReporter?.report({
            model: request.model,
            taskType: request.taskType,
            promptTokens: revalidated.promptTokens ?? 0,
            completionTokens: revalidated.completionTokens ?? 0,
            estimatedCostUsd: revalidated.estimatedCostUsd ?? 0,
            latencyMs: revalidated.latencyMs ?? 0,
            isCacheHit: true,
            status: revalidated.status
          });
        } catch { /* telemetry isolation */ }
        return cacheHit;
      }
      // Fall through to fresh call when the cached row is no longer valid.
    }

    const startedAt = Date.now();
    try {
      const result = await this.provider(request);
      const parsedOutput = this.registry.validate(request.taskType, result.output);
      const record: LlmEvaluationRecord = {
        ...request,
        id: uuidFromStableKey(`${request.taskType}:${request.promptVersion}:${request.model}:${inputHash}`),
        inputHash,
        output: result.output,
        parsedOutput,
        status: parsedOutput ? "succeeded" : "failed",
        promptTokens: result.tokenUsage?.promptTokens ?? 0,
        completionTokens: result.tokenUsage?.completionTokens ?? 0,
        estimatedCostUsd: this.costCalculator
          ? this.costCalculator.calculate(request.model, {
              promptTokens: result.tokenUsage?.promptTokens ?? 0,
              completionTokens: result.tokenUsage?.completionTokens ?? 0
            })
          : 0,
        latencyMs: result.latencyMs ?? Date.now() - startedAt,
        createdAt: new Date(startedAt).toISOString(),
        payloadSchemaVersion: this.registry.schemaVersionFor(request.taskType),
        isPersisted: true
      };
      await this.repository.save(record);
      try {
        this.traceReporter?.report({
          model: request.model,
          taskType: request.taskType,
          promptTokens: record.promptTokens,
          completionTokens: record.completionTokens,
          estimatedCostUsd: record.estimatedCostUsd,
          latencyMs: record.latencyMs,
          isCacheHit: false,
          status: record.status
        });
      } catch { /* telemetry isolation */ }
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
        createdAt: new Date(startedAt).toISOString(),
        payloadSchemaVersion: this.registry.schemaVersionFor(request.taskType),
        isPersisted: true
      };
      await this.repository.save(record);
      try {
        this.traceReporter?.report({
          model: request.model,
          taskType: request.taskType,
          promptTokens: 0,
          completionTokens: 0,
          estimatedCostUsd: 0,
          latencyMs: record.latencyMs,
          isCacheHit: false,
          status: "failed"
        });
      } catch { /* telemetry isolation */ }
      return record;
    }
  }
}

function revalidateCachedOutput(
  cached: LlmEvaluationRecord,
  registry: LlmOutputValidatorRegistry,
  request: LlmEvaluationRequest
): LlmEvaluationRecord {
  if (cached.status !== "succeeded" || !cached.parsedOutput) {
    return cached;
  }
  const expectedVersion = registry.schemaVersionFor(request.taskType);
  if (cached.payloadSchemaVersion && cached.payloadSchemaVersion === expectedVersion) {
    return cached;
  }
  const reparsed = registry.validate(request.taskType, cached.parsedOutput);
  if (!reparsed) {
    return { ...cached, status: "failed", parsedOutput: undefined, payloadSchemaVersion: expectedVersion };
  }
  return { ...cached, parsedOutput: reparsed, payloadSchemaVersion: expectedVersion };
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

function defaultValidatorRegistry(): LlmOutputValidatorRegistry {
  // The generic gateway keeps the small, task-agnostic validators. The
  // scanner registers its own schemas via PersistedLlmGatewayOptions so
  // that scanner domain churn does not leak into the shared LLM
  // persistence module (issue #14). For backwards compatibility with
  // generic callers / tests that don't pass a registry, the default
  // registry still includes the scanner task schemas via a one-line
  // delegation.
  return new LlmOutputValidatorRegistry()
    .register("adversarial_critique", "v1", adversarialCritiqueSchema())
    .register("explanation", "v1", explanationSchema())
    .register("market_equivalence", "v1", marketEquivalenceDefaultSchema())
    .register("market_normalization", "v1", marketNormalizationDefaultSchema());
}

function adversarialCritiqueSchema(): ZodType<Record<string, unknown>> {
  return z
    .object({
      accepted: z.boolean(),
      explanation: z.string().min(1)
    })
    .strict()
    .or(
      z
        .object({
          refuted: z.boolean(),
          explanation: z.string().min(1)
        })
        .strict()
    );
}

function explanationSchema(): ZodType<Record<string, unknown>> {
  return z
    .object({
      explanation: z.string().min(1)
    })
    .strict();
}

function marketEquivalenceDefaultSchema(): ZodType<Record<string, unknown>> {
  // Backwards-compatible default for callers that do not pass a
  // domain-specific registry. Mirrors the scanner's equivalence schema
  // (issue #7 — numeric strings coerced).
  return z
    .object({
      equivalent: z.boolean(),
      confidence: z.coerce.number().min(0).max(1),
      explanation: z.string().min(1)
    })
    .strict();
}

function marketNormalizationDefaultSchema(): ZodType<Record<string, unknown>> {
  return z
    .object({
      topic: z.enum(["crypto", "macro"]),
      eventType: z.enum(["price_above", "price_below", "fed_rate_decision", "cpi_range"]),
      asset: z.enum(["BTC", "ETH"]).nullable(),
      threshold: z.coerce.number().finite().nullable(),
      operator: z.enum([">", ">=", "<", "<=", "=", "between"]).nullable(),
      deadline: z.string().datetime().nullable(),
      timezone: z.string().min(1).nullable(),
      resolutionSource: z.string().min(1).nullable(),
      payoffType: z.enum(["at_time", "any_time_before", "range", "settlement_value"]),
      confidence: z.coerce.number().min(0).max(1),
      ambiguityFlags: z.array(z.string())
    })
    .strict();
}
