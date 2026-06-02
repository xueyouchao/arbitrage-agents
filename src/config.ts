/**
 * Typed environment configuration. Loads from process.env (which the runner
 * populates from .env via a small bootstrapper, see infra/env.ts).
 *
 * Single source of truth: every other module imports `cfg` from here.
 */

function parseEnv() {
  const env = process.env;
  const get = (k: string, d: string) =>
    env[k] === undefined || env[k] === "" ? d : (env[k] as string);
  const num_ = (k: string, d: number) => {
    const v = env[k];
    if (v === undefined || v === "") return d;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`env ${k} must be a number, got ${v}`);
    return n;
  };

  return {
    mode: (get("MODE", "paper") as "paper" | "live"),
    bankrollUsdc: num_("BANKROLL_USDC", 3000),
    maxTradePct: num_("MAX_TRADE_PCT", 0.02),
    maxOpenPositions: num_("MAX_OPEN_POSITIONS", 3),
    dailyDrawdownPct: num_("DAILY_DRAWDOWN_PCT", 0.03),
    weeklyMinSharpe: num_("WEEKLY_MIN_SHARPE", 0.5),
    edgeThreshold: num_("EDGE_THRESHOLD", 0.02),
    volFloor15m: num_("VOL_FLOOR_15M", 0.003),
    tauFracGate: num_("TAU_FRAC_GATE", 0.5),
    binanceWs: get("BINANCE_WS", "wss://stream.binance.com:9443/ws"),
    coinbaseWs: get("COINBASE_WS", "wss://ws-feed.exchange.coinbase.com"),
    polygonRpcUrl: get("POLYGON_RPC_URL", "https://polygon-rpc.com"),
    polygonRpcFallback: get("POLYGON_RPC_FALLBACK", "https://polypulse.com"),
    polymarketClobUrl: get("POLYMARKET_CLOB_URL", "https://clob.polymarket.com"),
    polymarketWsUrl: get("POLYMARKET_WS_URL", "wss://ws-subscriptions-clob.polymarket.com/ws/market"),
    privateKey: get("PRIVATE_KEY", ""),
    kalshiApiBase: get("KALSHI_API_BASE", "https://api.elections.kalshi.com/trade-api/v2"),
    kalshiApiKeyId: get("KALSHI_API_KEY_ID", ""),
    kalshiPrivateKeyPemPath: get("KALSHI_PRIVATE_KEY_PEM_PATH", ""),
    ollamaBaseUrl: get("OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
    debateModels: get("DEBATE_MODELS", "minimax-m3:cloud,deepseek-v4-pro:cloud,glm-5.1:cloud,kimi-k2.6:cloud")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    forensicsModel: get("FORENSICS_MODEL", "deepseek-v4-flash:cloud"),
    regimeModel: get("REGIME_MODEL", "glm-5.1:cloud"),
    llmTimeoutMs: num_("LLM_TIMEOUT_MS", 12000),
    llmMaxTokens: num_("LLM_MAX_TOKENS", 400),
    logLevel: (get("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error"),
    logPath: get("LOG_PATH", "./logs"),
  };
}

export type Config = ReturnType<typeof parseEnv>;
export const cfg: Config = parseEnv();
