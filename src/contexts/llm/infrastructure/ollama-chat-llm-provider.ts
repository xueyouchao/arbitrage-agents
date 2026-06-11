import { LlmEvaluationRequest, LlmProviderResult } from "../application/llm-evaluation";

export interface OllamaChatLlmProviderOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

export class OllamaChatLlmProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OllamaChatLlmProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async evaluate(request: LlmEvaluationRequest): Promise<LlmProviderResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await this.fetchImpl(this.options.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.options.model,
          stream: false,
          think: false,
          options: { temperature: 0, num_ctx: 16_000 },
          messages: [{ role: "user", content: promptFor(request) }]
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Ollama chat provider returned HTTP ${response.status}`);
      }

      const payload = await response.json() as OllamaChatResponse;
      const content = payload.message?.content;
      if (!content) {
        throw new Error("Ollama chat provider returned an empty message");
      }

      return {
        output: parseJsonContent(content),
        tokenUsage: {
          promptTokens: payload.prompt_eval_count ?? 0,
          completionTokens: payload.eval_count ?? 0
        },
        latencyMs: payload.total_duration ? Math.round(payload.total_duration / 1_000_000) : Date.now() - startedAt
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function promptFor(request: LlmEvaluationRequest): string {
  return [
    "You are a stateless prediction-market scanner reviewer.",
    "Return only strict JSON. Do not include markdown, prose, or comments.",
    `Task type: ${request.taskType}`,
    `Prompt version: ${request.promptVersion}`,
    `Required schema: ${schemaInstructionFor(request.taskType)}`,
    "Input JSON:",
    JSON.stringify(request.input)
  ].join("\n");
}

function schemaInstructionFor(taskType: LlmEvaluationRequest["taskType"]): string {
  if (taskType === "market_normalization") {
    return JSON.stringify({
      topic: "crypto|macro",
      eventType: "price_above|price_below|fed_rate_decision|cpi_range",
      asset: "BTC|ETH|null",
      threshold: "number|null",
      operator: ">|>=|<|<=|=|between|null",
      deadline: "ISO-8601 string|null",
      timezone: "string|null",
      resolutionSource: "string|null",
      payoffType: "at_time|any_time_before|range|settlement_value",
      confidence: "number 0..1",
      ambiguityFlags: ["string"]
    });
  }

  if (taskType === "market_equivalence") {
    return JSON.stringify({
      equivalent: "boolean",
      confidence: "number 0..1",
      explanation: "non-empty string"
    });
  }

  if (taskType === "adversarial_critique") {
    return JSON.stringify({ accepted: "boolean", explanation: "non-empty string" });
  }

  return JSON.stringify({ explanation: "non-empty string" });
}

function parseJsonContent(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const jsonText = fenced ?? trimmed;
  const parsed = JSON.parse(jsonText) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Ollama chat provider returned non-object JSON");
  }
  return parsed as Record<string, unknown>;
}
