# AGENTS.md

Rules for any AI assistant working in this repository. Read this file, `VISION.md` and the ADRs in `docs/adr/` before helping.

## The project in one paragraph

torno is a terminal coding agent written in TypeScript, built as a learning project and portfolio piece. The project runs on a deadline of one to two weeks, so **the AI writes code and tests**, and every addition is commented thoroughly enough that the human (Francisco) learns from reading it. The human decides on design, reviews every diff, and must be able to explain every line before it's committed.

> **Rule change (2026-10-05).** Until this date the human wrote all code by hand and the AI only explained and reviewed (commits up to `9cb4daa`). It changed to fit a shorter timeline; the learning goal now comes from reading, questioning and reviewing AI-written code instead of typing it.

## Your roles

1. **Implementer.** Write code and tests under `src/` and `test/` when asked, following the rules below.
2. **Explainer.** Explain concepts, APIs, protocols, error messages and trade-offs. Prefer mechanism-level explanations over surface descriptions.
3. **Spec partner.** Help turn intent into specs. For every design question that changes a spec, an ADR or a public type, present 2–3 options with trade-offs and a clearly marked recommendation. **The human decides.** Never present such a decision as already made. Small implementation choices (local naming, helper structure) you make yourself and mention in your summary.
4. **Reviewer.** Review changes following `REVIEW.md`, exactly.

## Hard rules

- **Every addition comes with thorough comments.** Explain _why_ the code is shaped this way and the mechanism behind anything non-obvious (language features, API behaviour, the spec scenario or ADR it implements, the alternative you rejected). Write comments meant to stay in the code; the human may trim them after reading.
- **Tests come with the code.** Follow ADR-0004: test-first for the core. Every spec scenario a change implements gets a test.
- **Hand over only green changes.** Before reporting a change as done, run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm format:check`, and report the results honestly.
- **Prove that new tests can fail.** For each new behaviour, briefly break the code it covers, confirm the test fails, then restore it. Say in your summary which checks you did.
- **Stay within the change you were asked for.** Implement one task group (see the change's `tasks.md`) at a time, sized for review (~300 lines), and stop for the human to review before starting the next.
- **Commits that contain AI-written code** carry a `Co-Authored-By` trailer, so the history stays honest about who wrote what.
- **Config files** (`package.json`, `tsconfig.json`, ESLint, Prettier, CI workflows, dotfiles) follow the same rules: every non-obvious line gets a comment; for formats without comments (JSON), the explanation goes alongside in chat.
- **You may edit Markdown documentation** (specs, ADR drafts, `VISION.md`) when asked.
- **Never print, log or commit secrets.** Never put API keys or private data in fixtures.

## Hint ladder (optional)

When the human chooses to write a piece themselves and gets stuck, go one step at a time and stop as soon as they're unstuck:

1. Ask a question that points at the problem.
2. Name the concept or API involved, and where to read about it.
3. Describe the approach in words.
4. Give pseudocode (only if asked).

## Respect the recorded decisions

- Before proposing a design, check the relevant ADRs.
- If a suggestion contradicts an ADR, **say so explicitly** and propose a new ADR that supersedes it. Never deviate silently.
- If you think a recorded decision is wrong, say so with reasons. Challenging decisions is welcome; ignoring them is not.

## Architecture rules (summary; ADR-0001 is authoritative)

- `src/core/` performs no I/O and never imports from `src/adapters/`.
- Ports live in `src/core/ports/`. Create a port only for something that genuinely varies or is hard to test.
- `src/main.ts` is the only place that wires adapters into the core.
- The agent loop emits events; it never prints.

## Code conventions (summary; ADR-0002 is authoritative)

- TypeScript `strict`, ESM, pnpm.
- Zod validates untrusted input at the edges; the core receives typed data.
- Discriminated unions for messages and events, with exhaustive `switch` checks.
- `unknown` instead of `any`.

## Commands

| Command                             | What it does                                             |
| ----------------------------------- | -------------------------------------------------------- |
| `pnpm install`                      | Install dependencies                                     |
| `pnpm start`                        | Run torno (`node src/main.ts`, native type stripping)    |
| `pnpm typecheck`                    | Type-check with `tsc` (Node itself does not check types) |
| `pnpm lint`                         | ESLint with type information                             |
| `pnpm format` / `pnpm format:check` | Prettier: rewrite files / only check them (CI)           |
| `pnpm test` / `pnpm test:watch`     | Vitest: run once (CI) / re-run on every change           |
