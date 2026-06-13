# Plan: fix `.github/workflows/ai-review.yml`

## Current state
- The workflow was modified by previous agents to add dotted env vars, but still:
  - Points Ollama jobs at `https://ollama.com` with bare model names (`ollama_chat/deepseek-v4-flash`).
  - Uses `OLLAMA.API_BASE`/`OLLAMA_API_BASE` and `OLLAMA.API_KEY` which LiteLLM’s `ollama_chat` provider does not turn into an `Authorization: Bearer` header.
  - Has a `config.model` env var that PR-Agent may not read (PR-Agent v0.36.0 typically uses `config__model` or repo `.pr_agent.toml`, not `config.model`).
  - Has auto-improve disabled but comments note it causes the "Failed to generate code suggestions for PR" error.

## Root cause of the reported error
"Failed to generate code suggestions for PR" is the message PR-Agent posts when `/improve` runs and the model/diff fails. The current file sets `github_action_config.auto_improve: "false"`, so this error should not come from this workflow unless another copy of PR-Agent (GitHub App or another workflow) is running. We will verify by keeping the workflow review-only and making sure `auto_improve` is explicitly false.

## User requirements
1. Ollama jobs must hit **Ollama Cloud** directly (not the local CCR proxy).
2. Three Ollama Cloud models: `minimax-m3:cloud`, `kimi-k2.7-code:cloud`, `deepseek-v4-flash:cloud`.
3. Keep two OpenRouter reviewers.
4. Use only `OPENROUTER_API_KEY` (no fallback to `OPEN_ROUTER_API_KEY`).
5. No Codex/OpenAI reviewer for now.

## Implementation approach
1. **Rewrite each job to use the correct PR-Agent env var format.**
   - PR-Agent v0.36.0 reads `config__model`, `config__fallback_models`, `pr_reviewer__...`, etc. (double-underscore, env-style), NOT dotted `config.model`.
   - Convert all `config.model` / `github_action_config.auto_review` style keys to `config__model` / `github_action_config__auto_review`.
2. **Fix Ollama Cloud authentication.**
   - Point Ollama Cloud jobs at the OpenAI-compatible endpoint `https://ollama.com/v1`.
   - Use `OPENAI__KEY` / `OPENAI__BASE` (PR-Agent dotted env form) plus `OPENAI_API_KEY` / `OPENAI_BASE_URL` (LiteLLM/OpenAI client form), all set from `secrets.OLLAMA_API_KEY` and the fixed base URL.
   - Do NOT set `OLLAMA_API_BASE` or `OLLAMA_API_KEY`; the `ollama_chat` provider does not inject them as an `Authorization: Bearer` header, and leaving stale vars would cause confusion if auth fails.
   - Use the `openai/<model>:cloud` model string so LiteLLM routes through the OpenAI-compatible path and sends the Bearer token automatically.
3. **Use `:cloud` suffix for Ollama Cloud models.**
   - Ollama Cloud model names include the `:cloud` tag. The previous claim that cloud-direct uses bare names is wrong in this environment — the user’s CCR config shows `:cloud` suffixes and the local doc confirms they are required.
4. **Clean up the workflow.**
   - Remove the generated `.pr_agent.toml` steps (they are ignored by the action and create confusion).
   - Keep the no-Claude guard as a single reusable step or inline check.
   - Keep `auto_review=true`, `auto_describe=false`, `auto_improve=false` for all jobs.
   - Add `continue-on-error: true` to each review job so one failing provider does not block the others.
   - Add a short top-level comment explaining how PR-Agent reads env vars.
5. **Secrets.**
   - OpenRouter: `OPENROUTER_API_KEY` only.
   - Ollama: `OLLAMA_API_KEY`.
   - No `OPENAI_API_KEY`.

## Files to edit
- `.github/workflows/ai-review.yml` (rewrite).

## Verification
- Validate YAML syntax with `python -c 'import yaml; yaml.safe_load(open(...))'`.
- Show the final file diff and summarize each job’s provider + model + secret.
- If the user later still sees "Failed to generate code suggestions for PR", the source is likely a GitHub App installation of PR-Agent or another workflow, not this file.
