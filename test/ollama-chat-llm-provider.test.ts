import { describe, expect, it, vi } from "vitest";
import { OllamaChatLlmProvider } from "../src/contexts/llm/infrastructure/ollama-chat-llm-provider";

describe("OllamaChatLlmProvider", () => {
  it("calls the configured CCR/Ollama chat endpoint and parses fenced JSON", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({
        message: { content: "```json\n{\"equivalent\":true,\"confidence\":0.82,\"explanation\":\"same event\"}\n```" },
        prompt_eval_count: 11,
        eval_count: 5,
        total_duration: 25_000_000
      }), { status: 200 })
    ) as typeof fetch;
    const provider = new OllamaChatLlmProvider({
      baseUrl: "http://127.0.0.1:11434/api/chat",
      model: "kimi-k2.6:cloud",
      timeoutMs: 1000,
      fetchImpl
    });

    const result = await provider.evaluate({ taskType: "market_equivalence", promptVersion: "v1", model: "kimi-k2.6:cloud", input: { pairId: "p1" } });

    expect(result).toEqual({
      output: { equivalent: true, confidence: 0.82, explanation: "same event" },
      tokenUsage: { promptTokens: 11, completionTokens: 5 },
      latencyMs: 25
    });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:11434/api/chat", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining("kimi-k2.6:cloud")
    }));
  });
});
