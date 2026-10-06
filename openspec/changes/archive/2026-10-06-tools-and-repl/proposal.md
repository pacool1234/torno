# Proposal

## Why

The agent loop works, but only against scripted tools and a scripted model. Nothing yet lets a person type a task and watch torno do it. This change adds the last pieces of the week-1 plan before the README (ADR-0007, step 4): the real tools, the safety gates around them (ADR-0005 levels 1 and 2), a line-based REPL, and the wiring in `src/main.ts`. At its end, `pnpm start` runs torno against Claude Haiku or a local model.

## What Changes

- **File tools** (`src/adapters/tools/`), implementing the `Tool` port, with Zod-validated input (ADR-0002):
  - `read_file`: reads a text file inside the project.
  - `write_file`: creates a file, or replaces one the model has read in this session.
  - `edit_file`: replaces one exact, unique occurrence of a string in a file the model has read in this session.
  - `write_file` and `edit_file` need approval; `read_file` doesn't.
- **Path confinement** (ADR-0005 level 2): every path is resolved to its real absolute location (`..`, symlinks) and refused if it's outside the project root. Tested against the pitfalls ADR-0005 lists: symlinks pointing out, prefix look-alikes (`/home/me/torno-evil`), and files that don't exist yet.
- **`bash` tool**: runs a command in the project root with a time limit, returns its output and exit status, and stops the whole process group when the turn is cancelled or the time runs out. Always needs approval. Known limitation (ADR-0005): it can reach anything the user can.
- **REPL** (`src/adapters/repl/`): reads a line, runs a turn, prints its events as they arrive (streamed text, tool activity, how the turn ended), and keeps the conversation between turns. It implements the `Approver` port by asking yes/no. Ctrl-C during a turn cancels it; the REPL stays usable.
- **Wiring in `src/main.ts`** (ADR-0001: the only place adapters meet the core): loads the configuration, builds the provider, tools, approver and REPL, and starts it. A short system prompt tells the model where it is and how to use the tools.

## Capabilities

### New Capabilities

- `file-tools`: reading, writing and editing files inside the project, with path confinement and read-before-change.
- `bash-tool`: running shell commands with a time limit and cancellation.
- `repl`: the interactive terminal session: input, rendering of agent events, the approval prompt, cancellation.

### Modified Capabilities

None.

## Impact

- New code under `src/adapters/tools/` and `src/adapters/repl/`, and `src/main.ts` replaced.
- Tests use real temporary directories (and, for `bash`, real short commands): fast, offline, no network.
- No new dependencies expected: `node:fs/promises`, `node:child_process` and `node:readline/promises` cover it.
- Not in this change: the permission allowlist, parallel tool calls, `glob`/`grep` tools, a diff view in the approval prompt, headless mode (all deferred by ADR-0007 or week 2).
