# VISION — torno

> _torno_: Spanish for lathe, from _tornear_, "to turn." The operator controls it; it shapes the work precisely, one turn at a time.

## Why this project exists

1. **Learn by building.** Understand, at mechanism level, how a coding agent works: the agent loop, provider protocols, streaming, tool calling, context management, cost.
2. **Learn software engineering properly.** Architecture (ports & adapters), testing, code review, written decisions — practised on a real system, not toy exercises.
3. **Produce a portfolio piece.** A public repo whose code I can explain line by line, and whose decisions are documented.
4. **Build the subject for a later eval project.** The agent must be runnable headless so a separate harness can compare models and harnesses on the same tasks.

## What it is

A terminal coding agent, written in TypeScript, that can read, search, edit and run code in a local repository, using any model reachable through the Anthropic Messages protocol (Anthropic's API, or local models via Ollama). OpenAI-compatible APIs are planned for later (ADR-0007).

## Non-goals

- Feature parity with Claude Code, OpenCode or any other product.
- A polished TUI. A plain line-based REPL is enough (ADR-0007).
- MCP, subagents, hooks or plan mode in the first release (ADR-0007).
- Multi-user, server or IDE-plugin modes.
- Optimising for any single model vendor.
- Native Windows support. torno targets Linux; on Windows it runs inside WSL2. macOS will probably work but is untested.

## Working method

- **Specs are AI-assisted; decisions are mine.** The AI proposes options with trade-offs. I choose, and record significant choices as ADRs in `docs/adr/`.
- **The AI writes code and tests; I review and understand them.** Every addition is commented thoroughly so that reading it teaches the mechanism (see `AGENTS.md`). Until 2026-10-05 I wrote all code by hand; the rule changed to fit a one-to-two-week timeline.
- **Tests come with the code**, before it for the core (ADR-0004). The AI proves each new test can fail; I check the cases cover the spec.
- **CI runs before review.** Typecheck, lint and tests must pass before the AI reviews a change.
- **Specs stay light.** Each openspec change has a proposal, specs and tasks; a `design.md` only when there's a real decision with alternatives (ADR-0007).
- **I review every task group; the AI reviews every change** following `REVIEW.md`. Severity levels (blocker / should-fix / nit), and every comment must name a concrete failure scenario. I may reject comments, with a reason.
- **Small changes.** Aim for under ~300 lines per task group.
- **Rule:** nothing gets merged that I can't explain line by line.

## Plan and exit criteria

Scope set by ADR-0007 (2026-10-05): one to two weeks, shared with another project. Week 1 must stand on its own. Each step ends with a working, tested, reviewed state on `main`.

### Week 1 — A working agent

1. **Provider port.** Canonical message and event types, the `ModelProvider` port, a scripted provider, and a small contract suite (`model-and-provider-port`).
2. **Anthropic-protocol adapter.** Raw HTTP: event-stream parsing, tool-call assembly from partial JSON, error mapping, cancellation. Developed against Ollama; validated against ~5 recorded Claude Haiku responses.
3. **Agent loop.** Emits events, never prints. Turn and `max_tokens` limits; tool calls run sequentially and all their results go back in one user message. Tested with the scripted provider.
4. **Tools and REPL.** `read_file`, `write_file`, `edit_file` (unique-match replacement, read-before-edit), `bash`. Path confinement (sandbox level 2) and a permission prompt for every write, edit and `bash` call (level 1). Line-based REPL; Ctrl-C cancels the current response.
5. **README** with a demo recording and an architecture overview.

**Exit:** from the REPL, torno completes a small multi-file change in a test repo using Claude Haiku, with every write and shell command approved by me. Ctrl-C mid-stream leaves a consistent state. The adapter passes its tests against the recorded responses.

### Week 2 (optional) — Measured

1. Token usage and cost per request and per task, from a price table.
2. Headless mode (`-p "task" --json`) and a JSONL trajectory per run (turns, tool calls, tokens, cost, timing).
3. Mini evaluation: about 5 small tasks × 2 models, results table in the README.
4. Prompt caching with one explicit breakpoint; cache hits visible in telemetry.

**Exit:** one script runs the task set against two models and the README shows the resulting success rate and cost per task.

### Later (not planned)

Recorded so they aren't forgotten; each needs a new ADR before it starts.

- OpenAI-compatible adapter (OpenRouter, DeepSeek, Kimi, local models), the second real test of the provider port (ADR-0003).
- Retry wrapper with backoff (design D5 of `model-and-provider-port`).
- Context management: truncation of large tool outputs, compaction, sessions, project memory file.
- Permission allowlist; parallel tool execution; `glob` and `grep` tools.
- Container sandbox for eval runs (level 4) and an OS-level sandbox (level 3).
- Subagents, MCP client, TUI, hooks, plan mode.

## Success criteria

- I can explain every line in `src/`.
- `src/core/` has thorough unit tests and imports nothing from `src/adapters/`.
- Every significant decision has an ADR.
- The README shows a working demo, and (if week 2 happens) real numbers: tasks completed and cost per task.

## Constraints

- **Budget:** development defaults to the scripted provider and local models via Ollama. Claude Haiku is used for recording fixtures, the demo and the evaluation. Paid APIs use prepaid credits with auto-reload off.
- **Secrets:** API keys live in `.env`, which is git-ignored from the first commit. `.env.example` documents the variables.
- **Platform:** Linux. Developed inside WSL2 on Windows, with the repo in the Linux filesystem (`~/code/torno`), not under `/mnt/c`. CI runs on Ubuntu.
- **Sandboxing** (ADR-0005, amended by ADR-0007):
  - Week 1: level 1 (permission prompts) and level 2 (file tools confined to the project root, after resolving `..` and symlinks). Known limitation: `bash` bypasses level 2.
  - Week 2 evaluation: no container. Each run uses a fresh temporary directory, a headless policy allowing only the tools the task needs, and small trusted task repos; the results state this limitation.
  - Later: level 4 (Linux container) for eval runs, level 3 (OS-level sandbox) evaluated.
- **License:** MIT. The repo goes public early.
- **Local models:** Ollama runs inside WSL2. Verify it's reachable (and has a model with tool calling) before starting the adapter.
