/**
 * LLM gateway. Calls ollama cloud via the native /api/chat endpoint — NOT
 * /v1/chat/completions (which 502s on this CCR setup, per the user's routing
 * doc). All calls are bounded by cfg.llmTimeoutMs and cfg.llmMaxTokens so a
 * slow / verbose model can't blow the context window.
 *
 * We use the `Agent` tool's `model` param as a trap, not a feature (per
 * ~/.claude/claude-code-ollama-routing.md). Always call ollama directly.
 */
import { cfg } from "../config.js";
import { httpJson } from "../infra/http.js";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOpts {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  think?: boolean;
}

export interface ChatResult {
  content: string;
  model: string;
  elapsedMs: number;
}

export async function chat(messages: ChatMsg[], opts: ChatOpts = {}): Promise<ChatResult> {
  const model = opts.model ?? cfg.debateModels[0]!;
  const body = {
    model,
    stream: false,
    think: opts.think ?? false,
    options: {
      temperature: opts.temperature ?? 0.2,
      num_ctx: 8192,
      num_predict: opts.maxTokens ?? cfg.llmMaxTokens,
    },
    messages,
  };
  const t0 = Date.now();
  const res = await httpJson<any>(`${cfg.ollamaBaseUrl}/api/chat`, body, {
    timeoutMs: cfg.llmTimeoutMs,
    retries: 1,
  });
  return {
    content: String(res?.message?.content ?? ""),
    model,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * Fan out the same prompt to N models in parallel. Returns one ChatResult per
 * model. If any model fails, we record the error in `content` rather than
 * throwing — this lets the debate continue even if one model is down.
 */
export async function fanOut(
  models: string[],
  messages: ChatMsg[],
  opts: Omit<ChatOpts, "model"> = {},
): Promise<ChatResult[]> {
  return Promise.all(
    models.map(async (m) => {
      try {
        return await chat(messages, { ...opts, model: m });
      } catch (e) {
        return { content: `ERROR(${m}): ${String(e)}`, model: m, elapsedMs: 0 };
      }
    }),
  );
}
