// Tests for the bash tool (tools-and-repl, group 4). They run real, short
// commands in a temporary project: what's under test is how the tool drives
// real processes (process groups, signals, pipes), which a fake would only
// imitate. Time limits are injected small, so no test waits long.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool } from "../../core/ports/tool.ts";
import { type TempProject, tempProject } from "../../../test/helpers/temp-project.ts";
import { createBash } from "./bash.ts";

let project: TempProject;
let bash: Tool;

beforeEach(async () => {
  project = await tempProject();
  bash = createBash(project.workspace, { env: { PATH: process.env.PATH ?? "" } });
});

afterEach(async () => {
  await project.remove();
});

const run = (command: string, signal = new AbortController().signal) =>
  bash.execute({ command }, signal);

// Whether a process still exists. Signal 0 checks without sending anything.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A killed process disappears a moment after the signal; poll briefly rather
// than assume it's instant.
async function expectGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && isAlive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(isAlive(pid)).toBe(false);
}

// The commands print `$!`, the pid of the background job, on the first line.
const firstLinePid = (result: string): number => Number(result.split("\n")[0]);

describe("bash: definition", () => {
  it("is called bash, always needs approval, and requires a command", () => {
    expect(bash.definition.name).toBe("bash");
    expect(bash.needsApproval).toBe(true);
    expect(bash.definition.inputSchema).toMatchObject({ required: ["command"] });
  });
});

describe("bash: running a command", () => {
  // Spec scenario "Success".
  it("returns the output and the exit code", async () => {
    expect(await run("echo hello")).toEqual({ result: "hello\n[exit code 0]", isError: false });
  });

  // Spec scenario "Failure".
  it("returns a non-zero exit as an error, with stderr included", async () => {
    const output = await run("echo oops >&2; exit 3");

    expect(output).toEqual({ result: "oops\n[exit code 3]", isError: true });
  });

  it("keeps stdout and stderr in the order they were written", async () => {
    expect((await run("echo one; echo two >&2; echo three")).result).toBe(
      "one\ntwo\nthree\n[exit code 0]",
    );
  });

  it("shows only the status line when there's no output", async () => {
    expect((await run("true")).result).toBe("[exit code 0]");
  });

  it("ends output without a final newline on its own line before the status", async () => {
    expect((await run("printf abc")).result).toBe("abc\n[exit code 0]");
  });

  it("reports a syntax error in the command", async () => {
    const output = await run("if then");

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(/syntax error/);
  });

  // Spec scenario "Runs in the project root".
  it("runs in the project root", async () => {
    expect((await run("pwd")).result).toBe(`${project.root}\n[exit code 0]`);
  });

  // Spec scenario "No input": a command waiting for input finishes at once.
  it("gives the command no input", async () => {
    expect((await run('read line; echo "got:$line"')).result).toContain("got:\n");
  });

  it("keeps non-ASCII output intact", async () => {
    expect((await run("echo 'torno — 旋盤 😀'")).result).toBe("torno — 旋盤 😀\n[exit code 0]");
  });
});

describe("bash: nothing outlives the command", () => {
  // Spec scenario "Background job". Without stopping the group, the result
  // would wait 1000 s: the background sleep keeps the output pipe open.
  it("returns without waiting for a background job, and stops it", async () => {
    const output = await run("sleep 1000 & echo $!");

    expect(output.isError).toBe(false);
    await expectGone(firstLinePid(output.result));
  });
});

describe("bash: time limit", () => {
  // Spec scenario "Stalled command".
  it("stops a command that runs too long, with everything it started", async () => {
    const quick = createBash(project.workspace, { env: {}, timeoutMs: 300 });

    const output = await quick.execute(
      { command: "sleep 1000 & echo $!; wait" },
      new AbortController().signal,
    );

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(/\[timed out after 0\.3 s\]$/);
    await expectGone(firstLinePid(output.result));
  });

  it("uses SIGKILL for a command that ignores SIGTERM", async () => {
    const quick = createBash(project.workspace, { env: {}, timeoutMs: 200, graceMs: 200 });

    const output = await quick.execute(
      { command: "trap '' TERM; echo $$; while true; do sleep 0.05; done" },
      new AbortController().signal,
    );

    expect(output.result).toMatch(/timed out/);
    await expectGone(firstLinePid(output.result));
  });
});

describe("bash: cancellation", () => {
  // Spec scenario "Cancelled with a child process".
  it("stops the command and its children when the signal aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const output = await run("sleep 1000 & echo $!; wait", controller.signal);

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(/\[cancelled\]$/);
    await expectGone(firstLinePid(output.result));
  });

  it("doesn't start a command when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const output = await run("touch started.txt", controller.signal);

    expect(output).toEqual({ result: "[cancelled]", isError: true });
    await expect(project.read("started.txt")).rejects.toThrow();
  });
});

describe("bash: bounded output", () => {
  // Spec scenario "Huge output": 1,000,000 characters, three distinct parts.
  it("keeps the first and last 100,000 characters, saying how many were left out", async () => {
    const output = await run(
      "head -c 100000 /dev/zero | tr '\\0' H; head -c 800000 /dev/zero | tr '\\0' M; head -c 100000 /dev/zero | tr '\\0' Z",
    );

    expect(output.result.startsWith("H".repeat(100_000))).toBe(true);
    expect(output.result).toContain("800000 characters left out");
    expect(output.result).not.toContain("M");
    expect(output.result.endsWith(`${"Z".repeat(100_000)}\n[exit code 0]`)).toBe(true);
  });
});

// An emoji is two UTF-16 units; 99,999 "a"s put it across the 100,000-unit
// cut, where half of it would be left as invalid text.
it("bash: never leaves half an emoji at the cut", async () => {
  const output = await run(
    "head -c 99999 /dev/zero | tr '\\0' a; printf '\\360\\237\\230\\200'; head -c 200000 /dev/zero | tr '\\0' b",
  );

  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
  expect(output.result).toContain("characters left out");
  expect(loneSurrogate.test(output.result)).toBe(false);
});

describe("bash: environment", () => {
  // Spec scenario "Key not visible".
  it("removes secret-looking variables, keeping the rest", async () => {
    const withSecrets = createBash(project.workspace, {
      env: {
        PATH: process.env.PATH ?? "",
        ANTHROPIC_API_KEY: "sk-ant-0000",
        GITHUB_TOKEN: "ghp_1111",
        db_password: "hunter2",
        MY_SECRET: "s3",
        OPENAI_API_KEY: "sk-2222",
        EDITOR: "vim",
      },
    });

    const output = await withSecrets.execute({ command: "env" }, new AbortController().signal);

    for (const hidden of [
      "ANTHROPIC_API_KEY",
      "sk-ant-0000",
      "GITHUB_TOKEN",
      "ghp_1111",
      "db_password",
      "hunter2",
      "MY_SECRET",
      "OPENAI_API_KEY",
      "sk-2222",
    ]) {
      expect(output.result).not.toContain(hidden);
    }
    expect(output.result).toContain("EDITOR=vim");
  });
});

describe("bash: invalid input", () => {
  // Spec scenario "Empty command".
  it.each([{ command: "" }, {}, { command: 42 }])(
    "reports %j without running anything",
    async (input) => {
      const output = await bash.execute(input, new AbortController().signal);

      expect(output.isError).toBe(true);
      expect(output.result).toMatch(/command/);
    },
  );
});
