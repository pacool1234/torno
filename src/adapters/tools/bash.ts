// The bash tool (spec bash-tool): runs one shell command in the project root.
// Always needs approval (ADR-0005): it can reach anything the user can, and
// the approval prompt is its only gate (level 2 doesn't apply to it).

import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolOutput } from "../../core/ports/tool.ts";
import { failure, inputSchemaOf, parseInput } from "./tool-input.ts";
import type { Workspace } from "./workspace.ts";

export type BashOptions = {
  // The environment the command sees, before secrets are removed. Defaults to
  // torno's own; tests pass a fixed one so results don't depend on the
  // developer's machine.
  env?: Record<string, string | undefined>;
  // Overridable so tests don't wait two minutes.
  timeoutMs?: number;
  // How long a process group gets between SIGTERM and SIGKILL.
  graceMs?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_GRACE_MS = 2_000;
// Per side: the first and the last 100,000 characters are kept. The loop's
// 30,000-character cap (ADR-0008) applies afterwards; this bound only stops a
// runaway command from filling memory before that.
const KEPT_EACH_SIDE = 100_000;

// Design, "bash": removed before the command runs, so `env` or a script that
// prints its environment can't put a key into the conversation.
const SECRET_NAME = /API_KEY|TOKEN|SECRET|PASSWORD/i;

const inputSchema = z.object({
  command: z.string().min(1).describe("The shell command to run, in the project root"),
});

// How the command ended, which decides the status line.
type Ending =
  | { kind: "exit"; code: number }
  | { kind: "signal"; signal: string }
  | { kind: "timeout"; seconds: number }
  | { kind: "cancelled" };

export function createBash(workspace: Workspace, options: BashOptions = {}): Tool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const env = withoutSecrets(options.env ?? process.env);

  return {
    definition: {
      name: "bash",
      description: `Run a shell command in the project root and return its output and exit code. No input is available, and commands are stopped after ${timeoutMs / 1000} seconds.`,
      inputSchema: inputSchemaOf(inputSchema),
    },
    needsApproval: true,
    execute: async (input, signal) => {
      const parsed = parseInput(inputSchema, input);
      if (!parsed.ok) {
        return parsed.output;
      }
      // Cancelled while the approval question was open, or just after: the
      // command must not start at all.
      if (signal.aborted) {
        return failure("[cancelled]");
      }
      return run(parsed.value.command, { cwd: workspace.root, env, timeoutMs, graceMs, signal });
    },
  };
}

function run(
  command: string,
  settings: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    graceMs: number;
    signal: AbortSignal;
  },
): Promise<ToolOutput> {
  const { cwd, env, timeoutMs, graceMs, signal } = settings;

  return new Promise((resolve) => {
    // `exec 2>&1` first: from then on the shell writes stderr into stdout,
    // so both arrive through one pipe in the order they were written. Two
    // pipes read by Node could interleave differently.
    //
    // detached: the command becomes the leader of a new process group, so
    // `process.kill(-pid)` reaches it and everything it starts (pipelines,
    // background jobs), not just the `bash` process.
    //
    // stdin "ignore": the command reads end-of-file at once instead of
    // waiting forever for input nobody will type.
    const child = spawn("bash", ["-c", `exec 2>&1\n${command}`], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = new BoundedText(KEPT_EACH_SIDE);
    // setEncoding makes the stream decode UTF-8 itself, carrying a character
    // split across two chunks over to the next one (a plain
    // `chunk.toString()` would turn each half into a replacement character).
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => output.add(text));
    child.stderr.on("data", (text: string) => output.add(text));

    // Set once, by whichever happens first: the time limit, a cancellation,
    // or the command's own exit.
    let stopping: Ending | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    // SIGTERM to the whole group asks everything to stop; SIGKILL after the
    // grace period ends whatever ignored it. A negative pid means "the
    // process group with this id".
    const stopGroup = (): void => {
      signalGroup(child.pid, "SIGTERM");
      killTimer ??= setTimeout(() => signalGroup(child.pid, "SIGKILL"), graceMs);
    };

    const timeLimit = setTimeout(() => {
      stopping ??= { kind: "timeout", seconds: timeoutMs / 1000 };
      stopGroup();
    }, timeoutMs);
    const onAbort = (): void => {
      stopping ??= { kind: "cancelled" };
      stopGroup();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    // "exit": bash itself has ended. Background jobs it started may still be
    // running, holding the pipe open, so "close" would wait for them; the
    // spec says nothing outlives the command, so the group is stopped now.
    child.on("exit", () => {
      stopGroup();
    });

    const finish = (ending: Ending): void => {
      clearTimeout(timeLimit);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      resolve(result(output.text(), ending));
    };

    // "close": the process has exited AND its pipes are closed, so all of
    // the output has been read. The result is built only then.
    child.on("close", (code, killedBy) => {
      if (stopping !== undefined) {
        finish(stopping);
      } else if (code !== null) {
        finish({ kind: "exit", code });
      } else {
        finish({ kind: "signal", signal: killedBy ?? "unknown signal" });
      }
    });

    // Spawning itself failed (e.g. no `bash` on PATH). "close" may not
    // follow, so this answers on its own.
    child.on("error", (error) => {
      clearTimeout(timeLimit);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      resolve(failure(`Could not run the command: ${error.message}`));
    });
  });
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone, which is the goal.
  }
}

function result(text: string, ending: Ending): ToolOutput {
  const status = statusLine(ending);
  // The status line always starts on a line of its own.
  const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  const isError = !(ending.kind === "exit" && ending.code === 0);
  return { result: `${body}${status}`, isError };
}

function statusLine(ending: Ending): string {
  switch (ending.kind) {
    case "exit":
      return `[exit code ${ending.code}]`;
    case "signal":
      return `[killed by ${ending.signal}]`;
    case "timeout":
      return `[timed out after ${ending.seconds} s]`;
    case "cancelled":
      return "[cancelled]";
    default: {
      const unhandled: never = ending;
      throw new Error(`Unhandled ending: ${JSON.stringify(unhandled)}`);
    }
  }
}

function withoutSecrets(env: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !SECRET_NAME.test(name)) {
      kept[name] = value;
    }
  }
  return kept;
}

// Collects text while keeping at most `keep` characters at each end. The
// middle is only counted. Memory stays bounded however much a command prints.
class BoundedText {
  readonly #keep: number;
  #head = "";
  #tail = "";
  #total = 0;

  constructor(keep: number) {
    this.#keep = keep;
  }

  add(text: string): void {
    this.#total += text.length;
    const roomInHead = this.#keep - this.#head.length;
    if (roomInHead > 0) {
      this.#head += text.slice(0, roomInHead);
      text = text.slice(roomInHead);
    }
    if (text !== "") {
      this.#tail = (this.#tail + text).slice(-this.#keep);
    }
  }

  text(): string {
    if (this.#total === this.#head.length + this.#tail.length) {
      // Nothing left out: head and tail are adjacent, so a character split
      // between them is whole again once joined.
      return this.#head + this.#tail;
    }
    // The cuts count UTF-16 units and may have split a surrogate pair (most
    // emoji). Half a pair isn't valid text, so it's dropped and counted as
    // left out, as the loop's own cap does (ADR-0008).
    const head = /[\uD800-\uDBFF]$/.test(this.#head) ? this.#head.slice(0, -1) : this.#head;
    const tail = /^[\uDC00-\uDFFF]/.test(this.#tail) ? this.#tail.slice(1) : this.#tail;
    const omitted = this.#total - head.length - tail.length;
    return `${head}\n\n[... ${omitted} characters left out ...]\n\n${tail}`;
  }
}
