// Tests for the composition root (spec repl, "Wiring"). main.ts is run as a
// real child process, the way `pnpm start` runs it: what's under test is its
// startup behaviour, including the exit status.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MAIN = join(import.meta.dirname, "main.ts");

// Resolves with the exit code and both outputs, whatever the code is
// (execFile's callback reports a non-zero exit as an error).
function runMain(env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [MAIN],
      { env, timeout: 10_000 },
      (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : (child.exitCode ?? null), stdout, stderr });
      },
    );
    // No input: a started REPL would see end of input and quit at once.
    child.stdin?.end();
  });
}

describe("main", () => {
  // Spec scenario "Bad configuration". The environment is set explicitly, so
  // the developer's .env (loaded only by `pnpm start`) plays no part.
  it("prints a bad configuration's message and exits with status 1, without a stack trace", async () => {
    const { code, stderr } = await runMain({
      PATH: process.env.PATH ?? "",
      ANTHROPIC_BASE_URL: "not a url",
    });

    expect(code).toBe(1);
    expect(stderr).toContain("ANTHROPIC_BASE_URL");
    // A stack trace has lines like "    at loadConfig (file:///...)".
    expect(stderr).not.toMatch(/^\s+at /m);
  });

  // With valid settings and no input, the REPL starts, sees end of input and
  // ends normally: the whole wiring loads without a network call.
  it("starts and ends cleanly when the input is empty", async () => {
    const { code, stdout } = await runMain({
      PATH: process.env.PATH ?? "",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      TORNO_MODEL: "test-model",
    });

    expect(code).toBe(0);
    expect(stdout).toContain("torno");
    expect(stdout).toContain("test-model");
  });
});
