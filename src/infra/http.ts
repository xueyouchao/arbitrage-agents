/**
 * Retrying fetch with exponential backoff + jitter. Capped at cfg.llmTimeoutMs
 * for LLM-style calls, and at a separate budget for CLOB RPC. We avoid the
 * global `fetch` agent pooling in v1 — simplicity beats premature optimization.
 */
import { cfg } from "../config.js";

export interface HttpOpts {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

export async function httpJson<T = unknown>(
  url: string,
  body: unknown,
  opts: HttpOpts = {},
): Promise<T> {
  const timeout = opts.timeoutMs ?? cfg.llmTimeoutMs;
  const retries = opts.retries ?? 2;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) {
        const backoff = 100 * 2 ** attempt + Math.random() * 50;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw new Error(`httpJson failed after ${retries + 1} attempts: ${String(lastErr)}`);
}
