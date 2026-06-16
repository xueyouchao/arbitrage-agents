# Paper Trading Runbook

This directory contains a small CLI dashboard that compares the edge advertised
by the opportunity calculator (`apparentEdge`) with the edge realized by the
deterministic paper-trade simulator (`actionableEdge`) per target notional.

## Files

- `paper-trade-dashboard.ts` — reusable dashboard library and renderer.
- `paper-trade-runbook.ts` — CLI entrypoint that queries Postgres.

## Usage

```bash
export DATABASE_URL=postgres://...
npx ts-node runbook/paper-trade-runbook.ts <opportunity-id> [target-notional,...]
```

Example:

```bash
npx ts-node runbook/paper-trade-runbook.ts \
  00000000-0000-4000-8000-000000000401 \
  5,25,100
```

## Output

The printed table contains one row per target notional:

- `notional` — target USD notional.
- `apparentEdge` — opportunity-level net edge for that notional (optimistic).
- `actionableEdge` — paper-trade simulation net edge after fills and costs.
- `leakage` — `apparentEdge - actionableEdge`.
- `expPnlUsd` — expected PnL at the actionable edge.
- `fees` / `slippage` — combined costs across both legs.
- `residual` — unfilled notional on a partial fill.
- `partial` / `actionable` — flags for execution quality.

A summary line reports `executableSizeUsd`, the best actionable notional, and the
worst edge leakage in basis points.
