# Design

> **Status: decided (2026-10-06).** D1–D4 were decided by Francisco; the alternatives stay below as the record.

## Context

- ADR-0001: the core sees tools only through the `Tool` port and approval only through the `Approver` port; `src/main.ts` is the only place adapters are wired in.
- ADR-0005: level 1 (approval for every write, edit and `bash` call) and level 2 (file tools confined to the project root, checked on the resolved path). Known limitation: `bash` bypasses level 2.
- ADR-0007: no allowlist, no parallel tool calls, a plain line-based REPL.
- ADR-0008: the loop already caps every tool result at 30,000 characters.

## Decisions

### D1. Tools use Node's APIs directly — decided

The tools are adapters (`src/adapters/tools/`) that call `node:fs/promises` and `node:child_process` themselves, and their tests run against real temporary directories and real short commands. The `Tool` port is the boundary the core depends on; a second boundary behind it would be over-abstraction (ADR-0001's rule), and real directories are the only honest test of symlink handling, which path confinement depends on.

Alternative: `FileSystem` and `Shell` ports with in-memory fakes (faster tests, but the fakes would need their own symlink logic, hiding exactly the pitfalls the tests must catch).

### D2. Secret files are refused — decided

File tools refuse any path whose resolved file name is `.env` or starts with `.env.`, except `.env.example`, for reading and for writing. The refusal is an error result that says why, so the model can tell the user instead of trying around it. The check runs on the resolved path, so a symlink named `notes.txt` pointing at `.env` is refused too.

`bash` is not covered (ADR-0005's accepted limitation): `cat .env` is only stopped by the approval prompt. As defence in depth, `bash` runs with secret-looking variables removed from its environment (see "Choices that follow").

Alternatives: approval for reading `.env` (reads normally don't ask, so it's a special case the user may approve by reflex); no special handling (one `read_file` puts the API key into a request, a log, maybe a recording).

### D3. Read before change, with a staleness check — decided

A per-session **read log** records, for each file the model reads, the SHA-256 hash of the content it saw, keyed by resolved path. `edit_file`, and `write_file` on an existing file, require an entry, and require the file's current hash to match it:

- No entry: refused with "Read the file first."
- Hash differs: refused with "The file changed since you read it; read it again." This protects edits the user made by hand during the session.
- After a successful write or edit, the entry is updated to the new content, so the model can make several edits in a row without re-reading.
- `write_file` creating a new file needs no entry, and records one.

The read log is plain state shared by the three file tools of one session, created in `main.ts`.

Alternatives: only require that a read happened (an edit can silently undo the user's changes); no rule (`write_file` could replace any file unseen).

### D4. Approval prompt: a summary, then y/N — decided

The REPL asks with a short summary and a default of No:

- `bash`: the whole command.
- `edit_file`: the path, then the old and new text.
- `write_file`: the path, the line count, and "create" or "replace".

Building the summary needs file-system knowledge ("create" or "replace"), which the REPL shouldn't have. The tools module therefore exports `summarizeCall(call)`, and `main.ts` hands it to the REPL. The summary works from the raw input before validation; if the input is malformed it shows it as JSON, and the tool's own validation rejects it afterwards.

Alternative: a unified diff (clearer for large edits, but needs a diff algorithm: scope ADR-0007 would cut).

## Choices that follow, recorded for reference

**Path confinement**

- The project root is resolved once at startup with `realpath`.
- A requested path is resolved against the root. If it exists, it's passed through `realpath` (following every symlink). If it doesn't (a new file), the nearest existing ancestor is passed through `realpath` and the missing segments are appended.
- It's inside the root when `path.relative(root, resolved)` doesn't start with `..` and isn't absolute. This handles the prefix look-alike (`/home/me/torno-evil`), which a string prefix check gets wrong.
- The tool then operates on the resolved path, never on the string the model sent. A symlink swapped between the check and the use (time-of-check vs time-of-use) remains possible; level 2 accepts that, and levels 3–4 are the real answer (ADR-0005).

**File tools**

- Input is validated with Zod; a validation failure is an error result naming the problem.
- `read_file` refuses files over 1 MB and files with a NUL byte in their first 8 KB (treated as binary). It returns the text as is, without line numbers, so the model can copy text into `edit_file` exactly.
- `edit_file` needs `old_text` to occur exactly once: zero matches and several matches are both errors (the latter says how many, and asks for more context). The replacement uses slicing, not `String.replace`, whose `$&`-style patterns would corrupt replacement text containing `$`.
- `write_file` creates missing parent directories inside the root.

**`bash`**

- `bash -c <command>` in the project root, with stdin closed, stdout and stderr combined in arrival order.
- Started in its own process group (`detached: true`), so cancellation and the time limit can stop the command and everything it started: SIGTERM to the group, then SIGKILL after 2 seconds if it's still running.
- Time limit: 2 minutes per command.
- Output kept in memory: the first and last 100,000 characters; the loop's 30,000-character cap applies afterwards.
- Result: the output, then a status line (`[exit code 0]`, `[timed out after 120 s]`, `[cancelled]`). A non-zero exit, a timeout or a cancellation is an error result.
- Environment: the user's, minus `ANTHROPIC_API_KEY` and any variable whose name contains `API_KEY`, `TOKEN`, `SECRET` or `PASSWORD`. This keeps `env` or a failing script from echoing a key into the conversation. A command that needs one of those variables won't find it; the user can run it themselves.

**REPL**

- `node:readline/promises` on stdin/stdout. Prompt `> `.
- Events render as they arrive: text is written as it streams; a tool start prints a line with the tool and a short summary; a tool finish prints ok or the first line of the error; the turn's end prints nothing when completed, otherwise one line (`cancelled`, `stopped: step limit — type "continue" to go on`, `stopped: output limit`, `error (<kind>): <message>`).
- The conversation is kept between turns, replaced by the one each `turn_ended` returns.
- Ctrl-C during a turn aborts the turn's signal (an open approval question included). At the prompt it prints how to quit. Ctrl-D or `exit` quits.
- The REPL takes its input and output streams as parameters, and exposes `interrupt()`, which `main.ts` connects to readline's SIGINT. Tests drive it with in-memory streams and call `interrupt()` directly, since a non-terminal stream never produces SIGINT.

**Wiring**

- `pnpm start` runs `node --env-file-if-exists=.env src/main.ts`. The project root is the current directory.
- The system prompt is a few lines: torno's role, the project root, "read a file before changing it", "prefer small edits", "keep answers short".
