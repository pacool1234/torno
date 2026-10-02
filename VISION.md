# VISION — torno

> *torno*: Spanish for lathe, from *tornear*, "to turn." The operator controls it; it shapes the work precisely, one turn at a time.

## Why this project exists

1. **Learn by building.** Understand, at mechanism level, how a coding agent works: the agent loop, provider protocols, streaming, tool calling, context management, cost.
2. **Learn software engineering properly.** Architecture (ports & adapters), testing, code review, written decisions — practised on a real system, not toy exercises.
3. **Produce a portfolio piece.** A public repo whose code I can explain line by line, and whose decisions are documented.
4. **Build the subject for a later eval project.** The agent must be runnable headless so a separate harness can compare models and harnesses on the same tasks.

## What it is

A terminal coding agent, written in TypeScript, that can read, search, edit and run code in a local repository, using any model reachable through the Anthropic Messages protocol or an OpenAI-compatible API.

## Non-goals

- Feature parity with Claude Code, OpenCode or any other product.
- A polished TUI before Phase 5. A plain line-based REPL is enough until then.
- MCP, subagents, hooks or plan mode before Phase 5.
- Multi-user, server or IDE-plugin modes.
- Optimising for any single model vendor.
- Native Windows support. torno targets Linux; on Windows it runs inside WSL2. macOS will probably work but is untested.

## Working method

- **Specs are AI-assisted; decisions are mine.** The AI proposes options with trade-offs. I choose, and record significant choices as ADRs in `docs/adr/`.
- **Code is written by hand.** The AI may explain APIs, concepts and errors. It does not write implementation code (see `AGENTS.md`).
- **Tests are written by me**, alongside or before the code. The AI points out missing cases during review.
- **CI runs before review.** Typecheck, lint and tests must pass before the AI reviews a change.
- **AI review follows `REVIEW.md`.** Severity levels (blocker / should-fix / nit), and every comment must name a concrete failure scenario. I may reject comments, with a reason.
- **Small changes.** Aim for under ~300 lines per review.
- **Rule:** nothing gets merged that I can't explain line by line.

## Phases and exit criteria

Each phase ends with a working, tested, reviewed state on `main`.

### Phase 1 — Foundation
Repo, CI, canonical message and event types, `ModelProvider` port, native Anthropic-protocol adapter (streaming, tool-call assembly from partial JSON, retries with backoff, cancellation), `FakeProvider`, per-request usage and cost telemetry.

**Exit:** a test-only script streams a response containing a tool call from a local model via Ollama. The same parser passes contract tests against recorded real Anthropic responses. Ctrl-C mid-stream leaves a consistent state.

### Phase 2 — Agent
The agent loop. Tools: `read`, `write`, `edit` (unique-match replacement, read-before-edit), `glob`, `grep`, `bash`. Parallel tool calls, permission prompts with allowlist (sandbox level 1), path confinement for file tools (sandbox level 2), turn and `max_tokens` limits, line-based REPL. OpenAI-compatible adapter (covers OpenRouter, DeepSeek, Kimi, local models). **Expect the provider port to change when this second adapter lands.**

**Exit:** the agent completes a small multi-file change in a test repo, with every write and shell command gated by permissions. The loop is covered by `FakeProvider` tests.

### Phase 3 — Context
Token budget, truncation of large tool outputs, conversation compaction, prompt caching (explicit where the provider needs it), loading a project memory file, saving and resuming sessions.

**Exit:** a long session stays under a configured token budget without losing the task. Cache hits are visible in telemetry.

### Phase 4 — Eval-ready
Headless mode (`-p "task" --json`), JSONL trajectories (turns, tool calls, tokens, cost, timing), provider pinning for reproducible runs, config file.

**Exit:** a script runs the same task with two models and produces comparable trajectory files.

### Phase 5 — Power features (open-ended)
Subagents (architect/worker with a cheaper worker model), MCP client, TUI, hooks, plan mode. Prioritised as I go.

## Success criteria

- I can explain every line in `src/`.
- `src/core/` has thorough unit tests and imports nothing from `src/adapters/`.
- At least one phase-5 feature is built *using the agent itself* (dogfooding).
- Every significant decision has an ADR.
- The README shows real numbers (tasks completed, cost per task), not just a feature list.

## Constraints

- **Budget:** development defaults to `FakeProvider` and local models via Ollama. Paid APIs use prepaid credits with auto-reload off.
- **Secrets:** API keys live in `.env`, which is git-ignored from the first commit. `.env.example` documents the variables.
- **Platform:** Linux. Developed inside WSL2 on Windows, with the repo in the Linux filesystem (`~/code/torno`), not under `/mnt/c`. CI runs on Ubuntu.
- **Sandboxing, applied by phase** (record as ADR-0005):
  - Phase 2: level 1 (permission prompts) and level 2 (file tools confined to the project root, after resolving `..` and symlinks). Known limitation: `bash` bypasses level 2.
  - Phase 4: level 4 (Linux container) for eval runs.
  - Phase 5: level 3 (OS-level sandbox, e.g. bubblewrap or Landlock) evaluated.
- **License:** MIT. The repo goes public early.
- **Local models:** Ollama runs inside WSL2. Verify the agent can reach it before starting Phase 1.