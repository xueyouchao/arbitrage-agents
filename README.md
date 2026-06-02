# Arbitrage Agents

Agentic, dynamic-workflow crypto/prediction-market arbitrage bot. **Deterministic hot path** in TypeScript, **offline multi-agent debate layer** around the edges. Paper-trade by default; live mode requires explicit configuration.

## Architecture

```
[binance WS]  [coinbase WS]  [polymarket WS]
        \           |             /
         v          v            v
        candle tracker (deterministic)
                 |
                 v
         fair-up-prob (BS binary delta, no LLM)
                 |
                 v
            detectEdge -> checkAll(risk gates)
                 |              |
                 v              v
         paper/live fill    kill switch
                 |
                 v
        NDJSON log + forensics

[weekly cron]  debate (4 ollama models) -> signal/params.json
[5-min loop]   regime classifier         -> signal/regime.json
[on loss]      forensics (1 cheap LLM)  -> logs/forensics/*.ndjson
```

The hot path is intentionally LLM-free. The agentic layer is async, fire-and-forget, and writes small JSON files that the hot path can read on next tick. This avoids context-window explosion and keeps deterministic execution predictable.

## Quick start

```bash
npm install
cp .env.example .env
npm run paper
npm run test
```

## Risk caps (hard-coded defaults)

| Cap                       | Default | Override env var      |
|---------------------------|---------|------------------------|
| Max trade % of bankroll   | 2%      | `MAX_TRADE_PCT`        |
| Max open positions        | 3       | `MAX_OPEN_POSITIONS`   |
| Daily drawdown halt       | -3%     | `DAILY_DRAWDOWN_PCT`   |
| Weekly min Sharpe         | 0.5     | `WEEKLY_MIN_SHARPE`    |
| Hard per-trade cap        | $1000   | (in `risk/gates.ts`)   |

The kill switch is triggered automatically when the weekly Sharpe falls below `WEEKLY_MIN_SHARPE` after at least 10 trades.

## Agentic LLM layer

All LLM calls go through `src/agents/llm.ts` → ollama cloud at `http://127.0.0.1:11434/api/chat` (NOT `/v1/chat/completions`, which 502s in this CCR setup).

Default model mix:
- **Debate** (weekly, 4-way fan-out): `minimax-m3:cloud`, `deepseek-v4-pro:cloud`, `glm-5.1:cloud`, `kimi-k2.6:cloud`
- **Forensics** (per-loss, cheap): `deepseek-v4-flash:cloud`
- **Regime** (every 5 min): `glm-5.1:cloud`

Outputs are bounded to ≤400 tokens per call. The debate consumes ~300 in, ~200 out. Total context per call stays under 4k tokens — no possibility of context explosion.

## Research basis

See `PROJECT.md` and `RESEARCH.md` for the June-2026 research synthesis and the four-model (minimax-m3, deepseek-v4-pro, glm-5.1, kimi-k2.6) fan-out that drove the architecture. The hot-path rules are: deterministic execution, agentic offline tuning, hard risk caps, $2–3K live / $5K reserve.

## Project layout

```
src/
  index.ts                 # entry
  config.ts                # typed env config
  infra/                   # env loader, logger, http
  feeds/                   # binance, coinbase, polymarket WS
  signal/                  # candle, fair-prob, edge detector
  risk/                    # gates (position size, drawdown, kill switch)
  paper/                   # simulator
  agents/                  # llm, debate, forensics, regime
  orchestrator/            # tick loop
scripts/                   # weekly-debate, regime
test/                      # vitest unit tests
```

## License

Internal research. Not financial advice.
