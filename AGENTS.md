<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **arbitrage-agents** (712 symbols, 1402 relationships, 43 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/arbitrage-agents/context` | Codebase overview, check index freshness |
| `gitnexus://repo/arbitrage-agents/clusters` | All functional areas |
| `gitnexus://repo/arbitrage-agents/processes` | All execution flows |
| `gitnexus://repo/arbitrage-agents/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

# DOX Framework

- DOX is installed for this repository as a maintained `AGENTS.md` hierarchy.
- `AGENTS.md` files are binding work contracts for their subtrees; read the root file plus each child `AGENTS.md` on the path to files you will touch.
- Closer `AGENTS.md` files control local work details, but no child file may weaken these root rules or the GitNexus block above.
- After meaningful changes, perform a DOX pass: update affected nearest owning `AGENTS.md` files, refresh affected Child DOX Index sections, remove stale guidance, and report any docs intentionally left unchanged.

## Project Contract

- This project is a read-only cross-venue prediction-market arbitrage intelligence scanner; do not add order placement, trade execution, custody, or autonomous trading side effects.
- Keep the NestJS API runtime and worker runtime separate: API code reads persisted data, while worker/scanner code performs venue fetches and scan orchestration.
- Preserve the DDD-inspired modular-monolith boundaries under `src/contexts`; put domain logic in context/domain areas and keep infrastructure concerns at context edges.
- Add environment variables through the central config module and keep secrets, DSNs, API keys, wallets, tokens, auth headers, and PII out of logs and persisted failure text.
- Use Node.js >=20. Common checks are `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:acceptance` when a disposable Postgres database is explicitly configured.

## Child DOX Index

- `src/AGENTS.md` — NestJS runtime composition, config/db modules, source-wide architecture rules, and the source subtree index.
- `drizzle/AGENTS.md` — committed migration and Drizzle metadata rules.
- `test/AGENTS.md` — Vitest and curl-based acceptance-test rules.
- `docs/AGENTS.md` — product, architecture, scope, and handoff documentation rules.

## DOX Exclusions

Do not create child `AGENTS.md` files in generated/cache/tool-state directories such as `node_modules/`, `dist/`, `coverage/`, `.gitnexus/parse-cache/`, `.understand-anything/`, `.claude/worktrees/`, or `.omc/` unless the user explicitly asks for tool-state documentation.
