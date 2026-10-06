// Tests for write_file and edit_file (tools-and-repl, group 3): read before
// change (design D3), unique-match editing, and the refusals they share with
// read_file. One file for both tools because they share the read-log rules,
// and each rule is tested for both.

import { readFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool } from "../../core/ports/tool.ts";
import { type TempProject, tempProject } from "../../../test/helpers/temp-project.ts";
import { createEditFile, createWriteFile } from "./change-file.ts";
import { createReadFile } from "./read-file.ts";

let project: TempProject;
let readFile_: Tool;
let writeFile_: Tool;
let editFile: Tool;

beforeEach(async () => {
  project = await tempProject();
  // The three tools share one read log, as main.ts will wire them.
  readFile_ = createReadFile(project.workspace, project.log);
  writeFile_ = createWriteFile(project.workspace, project.log);
  editFile = createEditFile(project.workspace, project.log);
});

afterEach(async () => {
  await project.remove();
});

const signal = new AbortController().signal;
const readTool = (path: string) => readFile_.execute({ path }, signal);
const write = (input: Record<string, unknown>) => writeFile_.execute(input, signal);
const edit = (input: Record<string, unknown>) => editFile.execute(input, signal);

describe("write_file and edit_file: definitions", () => {
  it.each([
    ["write_file", () => writeFile_, ["path", "content"]],
    ["edit_file", () => editFile, ["path", "old_text", "new_text"]],
  ] as const)("%s needs approval and requires its fields", (name, tool, required) => {
    expect(tool().definition.name).toBe(name);
    expect(tool().needsApproval).toBe(true);
    expect(tool().definition.inputSchema).toMatchObject({ required: [...required] });
  });
});

describe("write_file", () => {
  // Spec scenario "Create".
  it("creates a new file without a prior read, reporting created and the line count", async () => {
    const output = await write({ path: "b.txt", content: "a\nb\n" });

    expect(output).toEqual({ result: 'Created "b.txt" (2 lines).', isError: false });
    expect(await project.read("b.txt")).toBe("a\nb\n");
  });

  // Spec scenario "New file in a new directory".
  it("creates missing parent directories", async () => {
    await write({ path: "src/new/a.ts", content: "x" });

    expect(await project.read("src/new/a.ts")).toBe("x");
  });

  it("replaces a file it has read, reporting replaced", async () => {
    await project.write("a.ts", "old\n");
    await readTool("a.ts");

    const output = await write({ path: "a.ts", content: "new\n" });

    expect(output).toEqual({ result: 'Replaced "a.ts" (1 line).', isError: false });
    expect(await project.read("a.ts")).toBe("new\n");
  });

  it("counts lines of content without a final newline, and of empty content", async () => {
    expect((await write({ path: "one.txt", content: "a\nb" })).result).toContain("(2 lines)");
    expect((await write({ path: "none.txt", content: "" })).result).toContain("(0 lines)");
  });

  // A created file counts as read: the model knows its content, because it
  // wrote it, so it may edit it next without reading it back.
  it("lets the model edit a file it just created", async () => {
    await write({ path: "a.ts", content: "let x = 1;\n" });

    expect((await edit({ path: "a.ts", old_text: "1", new_text: "2" })).isError).toBe(false);
  });

  it("refuses to write over a directory", async () => {
    await project.write("src/a.ts", "x");

    const output = await write({ path: "src", content: "x" });

    expect(output.isError).toBe(true);
    expect((await stat(join(project.root, "src"))).isDirectory()).toBe(true);
  });
});

// Design D3, shared by both tools: each rule runs against both.
describe.each([
  ["write_file", () => write({ path: "a.ts", content: "replaced\n" })],
  ["edit_file", () => edit({ path: "a.ts", old_text: "1", new_text: "2" })],
])("%s: changes need a current read", (_name, change) => {
  // Spec scenario "Edit without reading".
  it("refuses an existing file the model hasn't read, leaving it unchanged", async () => {
    await project.write("a.ts", "let x = 1;\n");

    const output = await change();

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(/[Rr]ead the file first/);
    expect(await project.read("a.ts")).toBe("let x = 1;\n");
  });

  // Spec scenario "File changed since read": the user's edit must survive.
  it("refuses a file that changed since it was read, keeping the change", async () => {
    await project.write("a.ts", "let x = 1;\n");
    await readTool("a.ts");
    await project.write("a.ts", "let x = 1; // the user's edit\n");

    const output = await change();

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(/changed since/);
    expect(await project.read("a.ts")).toBe("let x = 1; // the user's edit\n");
  });

  // The read log is keyed by resolved path, so reading through a link and
  // changing through the real name is one file.
  it("accepts a read made through a symlink to the same file", async () => {
    await project.write("a.ts", "let x = 1;\n");
    await symlink(join(project.root, "a.ts"), join(project.root, "alias.ts"));
    await readTool("alias.ts");

    expect((await change()).isError).toBe(false);
  });
});

describe("edit_file", () => {
  // Spec scenario "Unique match".
  it("replaces the one occurrence and keeps the rest", async () => {
    await project.write("a.ts", "let x = 1;\nlet y = 1;\n");
    await readTool("a.ts");

    const output = await edit({ path: "a.ts", old_text: "let x = 1;", new_text: "let x = 2;" });

    expect(output).toEqual({ result: 'Edited "a.ts".', isError: false });
    expect(await project.read("a.ts")).toBe("let x = 2;\nlet y = 1;\n");
  });

  // Spec scenario "Two edits in a row".
  it("allows a second edit without reading again", async () => {
    await project.write("a.ts", "a b c");
    await readTool("a.ts");

    await edit({ path: "a.ts", old_text: "a", new_text: "A" });
    const second = await edit({ path: "a.ts", old_text: "c", new_text: "C" });

    expect(second.isError).toBe(false);
    expect(await project.read("a.ts")).toBe("A b C");
  });

  it("reports text that isn't there, leaving the file unchanged", async () => {
    await project.write("a.ts", "let x = 1;\n");
    await readTool("a.ts");

    const output = await edit({ path: "a.ts", old_text: "let z", new_text: "let w" });

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(/not found/);
    expect(await project.read("a.ts")).toBe("let x = 1;\n");
  });

  // Spec scenario "Several matches".
  it("refuses an ambiguous match, saying how many and asking for more context", async () => {
    await project.write("a.ts", "x + x + x");
    await readTool("a.ts");

    const output = await edit({ path: "a.ts", old_text: "x", new_text: "y" });

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(/3 times/);
    expect(output.result).toMatch(/more/);
    expect(await project.read("a.ts")).toBe("x + x + x");
  });

  // Spec scenario "Dollar signs in the replacement". String.replace would
  // turn "$&" into the matched text.
  it("inserts the new text literally, dollar signs included", async () => {
    await project.write("a.ts", "cost = 0");
    await readTool("a.ts");

    await edit({ path: "a.ts", old_text: "0", new_text: "$& + $1" });

    expect(await project.read("a.ts")).toBe("cost = $& + $1");
  });

  it("reports a missing file", async () => {
    const output = await edit({ path: "nope.ts", old_text: "a", new_text: "b" });

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(/does not exist/);
  });

  it("refuses identical old and new text", async () => {
    await project.write("a.ts", "same");
    await readTool("a.ts");

    expect((await edit({ path: "a.ts", old_text: "same", new_text: "same" })).isError).toBe(true);
  });
});

describe("write_file and edit_file: refusals", () => {
  it.each([
    ["write_file outside", () => write({ path: "../outside/x.txt", content: "x" }), /outside/],
    [
      "edit_file outside",
      () => edit({ path: "../outside/x.txt", old_text: "a", new_text: "b" }),
      /outside/,
    ],
    ["write_file .env", () => write({ path: ".env", content: "KEY=1" }), /secrets/],
    ["edit_file .env", () => edit({ path: ".env", old_text: "a", new_text: "b" }), /secrets/],
  ])("%s", async (_name, change, reason) => {
    const output = await change();

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(reason);
  });

  it("writes nothing outside the project", async () => {
    await write({ path: "../outside/x.txt", content: "x" });

    await expect(readFile(join(project.base, "outside", "x.txt"))).rejects.toThrow();
  });

  it.each([
    ["write_file without content", () => write({ path: "a.ts" }), /content/],
    ["edit_file without old_text", () => edit({ path: "a.ts", new_text: "b" }), /old_text/],
    [
      "edit_file with empty old_text",
      () => edit({ path: "a.ts", old_text: "", new_text: "b" }),
      /old_text/,
    ],
  ])("reports invalid input: %s", async (_name, change, field) => {
    const output = await change();

    expect(output.isError).toBe(true);
    expect(output.result).toMatch(field);
  });
});
