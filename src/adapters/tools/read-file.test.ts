// Tests for read_file and the read log (tools-and-repl, group 2). Real
// temporary directories, like the workspace tests: what's under test is how
// the tool meets the actual file system.

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadLog } from "./read-log.ts";
import { createReadFile } from "./read-file.ts";
import { Workspace } from "./workspace.ts";

let base: string;
let root: string;
let log: ReadLog;
let readFile: ReturnType<typeof createReadFile>;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "torno-read-")));
  root = join(base, "proj");
  await mkdir(root);
  log = new ReadLog();
  readFile = createReadFile(await Workspace.open(root), log);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const read = (input: Record<string, unknown>) =>
  readFile.execute(input, new AbortController().signal);

describe("read_file: the tool's definition", () => {
  it("is called read_file, needs no approval, and describes a required path", () => {
    expect(readFile.definition.name).toBe("read_file");
    expect(readFile.needsApproval).toBe(false);
    expect(readFile.definition.inputSchema).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
    // The JSON Schema dialect marker isn't part of what the API expects.
    expect(readFile.definition.inputSchema).not.toHaveProperty("$schema");
  });
});

describe("read_file: reading", () => {
  // Spec scenario "Text file".
  it("returns the file's text unchanged", async () => {
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");

    expect(await read({ path: "a.ts" })).toEqual({
      result: "export const a = 1;\n",
      isError: false,
    });
  });

  it("keeps non-ASCII text intact", async () => {
    await writeFile(join(root, "hola.txt"), "torno — 旋盤\n");

    expect((await read({ path: "hola.txt" })).result).toBe("torno — 旋盤\n");
  });

  it("returns an empty file as empty text", async () => {
    await writeFile(join(root, "empty.txt"), "");

    expect(await read({ path: "empty.txt" })).toEqual({ result: "", isError: false });
  });

  // Design D3: what the model read, keyed by the resolved path, is what a
  // later edit is checked against.
  it("records the content it returned in the read log, under the resolved path", async () => {
    await writeFile(join(root, "a.ts"), "v1");
    await symlink(join(root, "a.ts"), join(root, "alias.ts"));

    await read({ path: "alias.ts" });

    expect(log.check(join(root, "a.ts"), Buffer.from("v1"))).toBe("current");
    expect(log.check(join(root, "a.ts"), Buffer.from("v2"))).toBe("changed");
  });
});

describe("read_file: refusals and failures", () => {
  // Spec scenario "Missing file".
  it("reports a missing file", async () => {
    const output = await read({ path: "nope.ts" });

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(/does not exist/);
  });

  it("reports a directory", async () => {
    await mkdir(join(root, "src"));

    const output = await read({ path: "src" });

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(/directory/);
  });

  it("refuses a file over 1 MB, saying how big it is", async () => {
    await writeFile(join(root, "big.log"), "x".repeat(1024 * 1024 + 1));

    const output = await read({ path: "big.log" });

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(/too large/);
  });

  it("reads a file of exactly 1 MB", async () => {
    await writeFile(join(root, "edge.log"), "x".repeat(1024 * 1024));

    expect((await read({ path: "edge.log" })).isError).toBe(false);
  });

  // Spec scenario "Binary file".
  it("refuses a file with a NUL byte near the start", async () => {
    await writeFile(join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

    const output = await read({ path: "image.png" });

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(/binary/);
  });

  // Refusals from the workspace come back as error results, with its reason.
  it.each([
    ["outside the project", "../x.txt", /outside the project/],
    ["a secret file", ".env", /may contain secrets/],
  ])("refuses a path %s", async (_name, path, reason) => {
    await writeFile(join(base, "x.txt"), "outside");
    await writeFile(join(root, ".env"), "ANTHROPIC_API_KEY=x");

    const output = await read({ path });

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(reason);
    expect(output.result).not.toContain("ANTHROPIC_API_KEY");
  });

  it("records nothing for a file it didn't return", async () => {
    await writeFile(join(root, "image.png"), Buffer.from([0x00]));

    await read({ path: "image.png" });

    expect(log.check(join(root, "image.png"), Buffer.from([0x00]))).toBe("unread");
  });

  // Spec scenario "Missing path" (the file-tools "Invalid input" requirement).
  it.each([
    ["no path", {}],
    ["an empty path", { path: "" }],
    ["a path that isn't a string", { path: 42 }],
  ])("reports invalid input: %s", async (_name, input) => {
    const output = await read(input);

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(/path/);
  });
});
