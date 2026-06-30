import { describe, expect, it, vi } from "vitest";
import { OllamaChatLlmProvider } from "../src/contexts/llm/infrastructure/ollama-chat-llm-provider";

function fakeChatResponse(content: string, overrides: Record<string, unknown> = {}): typeof fetch {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({
      message: { content },
      prompt_eval_count: 11,
      eval_count: 5,
      total_duration: 25_000_000,
      ...overrides
    }), { status: 200 })
  ) as typeof fetch;
}

describe("OllamaChatLlmProvider", () => {
  it("calls the configured CCR/Ollama chat endpoint and parses fenced JSON", async () => {
    const fetchImpl = fakeChatResponse("```json\n{\"equivalent\":true,\"confidence\":0.82,\"explanation\":\"same event\"}\n```");
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

  it("uses the standard Ollama /api/chat request shape with think=false by default", async () => {
    const fetchImpl = fakeChatResponse("{\"explanation\":\"ok\"}") as ReturnType<typeof vi.fn>;
    const provider = new OllamaChatLlmProvider({
      baseUrl: "http://127.0.0.1:11434/api/chat",
      model: "glm-5.2:cloud",
      timeoutMs: 1000,
      fetchImpl
    });

    await provider.evaluate({ taskType: "explanation", promptVersion: "v1", model: "glm-5.2:cloud", input: {} });

    const [_url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "glm-5.2:cloud",
      stream: false,
      think: false,
      options: { temperature: 0, num_ctx: 16_000 },
      messages: [{ role: "user", content: expect.stringContaining("explanation") }]
    });
  });

  it("defaults the non-standard think field to false when not provided", async () => {
    const fetchImpl = fakeChatResponse("{\"explanation\":\"ok\"}") as ReturnType<typeof vi.fn>;
    const provider = new OllamaChatLlmProvider({
      baseUrl: "http://127.0.0.1:11434/api/chat",
      model: "llama3.1",
      timeoutMs: 1000,
      fetchImpl
    });

    await provider.evaluate({ taskType: "explanation", promptVersion: "v1", model: "llama3.1", input: {} });

    const [_url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.think).toBe(false);
    expect(body.model).toBe("llama3.1");
    expect(body.stream).toBe(false);
    expect(body.options).toEqual({ temperature: 0, num_ctx: 16_000 });
    expect(body.messages).toEqual([{ role: "user", content: expect.any(String) }]);
  });

  it("includes think=true when explicitly requested", async () => {
    const fetchImpl = fakeChatResponse("{\"explanation\":\"ok\"}") as ReturnType<typeof vi.fn>;
    const provider = new OllamaChatLlmProvider({
      baseUrl: "http://127.0.0.1:11434/api/chat",
      model: "glm-5.2:cloud",
      timeoutMs: 1000,
      think: true,
      fetchImpl
    });

    await provider.evaluate({ taskType: "explanation", promptVersion: "v1", model: "glm-5.2:cloud", input: {} });

    const [_url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.think).toBe(true);
  });

  it("reports ping reachability against /api/tags", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: { content: "{\"explanation\":\"ok\"}" } }), { status: 200 });
    }) as typeof fetch;

    const provider = new OllamaChatLlmProvider({
      baseUrl: "http://127.0.0.1:11434/api/chat",
      model: "glm-5.2:cloud",
      timeoutMs: 1000,
      fetchImpl
    });

    const ping = await provider.ping();
    expect(ping).toEqual({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:11434/api/tags", expect.objectContaining({ method: "GET" }));
  });

  it("ping returns ok=false and error message when the endpoint is unreachable", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => { throw new Error("ECONNREFUSED"); }) as typeof fetch;

    const provider = new OllamaChatLlmProvider({
      baseUrl: "http://unreachable:11434/api/chat",
      model: "glm-5.2:cloud",
      timeoutMs: 1000,
      fetchImpl
    });

    const ping = await provider.ping();
    expect(ping).toEqual({ ok: false, error: "ECONNREFUSED" });
  });
});
