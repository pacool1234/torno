// Tests for the approval summary (design D4, task 3.3): what the user sees
// before answering y/N. It's built from the model's raw input, before any
// validation, so malformed input must still produce something readable.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolCallBlock } from "../../core/conversation.ts";
import { type TempProject, tempProject } from "../../../test/helpers/temp-project.ts";
import { createSummarizer } from "./summarize.ts";

let project: TempProject;
let summarize: (call: ToolCallBlock) => Promise<string>;

beforeEach(async () => {
  project = await tempProject();
  summarize = createSummarizer(project.workspace);
});

afterEach(async () => {
  await project.remove();
});

const call = (toolName: string, input: Record<string, unknown>): ToolCallBlock => ({
  type: "tool_call",
  id: "c1",
  toolName,
  input,
});

describe("summarizeCall", () => {
  it("shows the whole bash command", async () => {
    expect(await summarize(call("bash", { command: "npm test -- --run" }))).toBe(
      "Run: npm test -- --run",
    );
  });

  it("shows the path, then the old and new text, for edit_file", async () => {
    const summary = await summarize(
      call("edit_file", { path: "a.ts", old_text: "let x = 1;", new_text: "let x = 2;" }),
    );

    expect(summary).toBe("Edit a.ts\n- let x = 1;\n+ let x = 2;");
  });

  // Each line of a multi-line text gets the marker, so the user can see
  // where the old text ends and the new one starts.
  it("marks every line of multi-line edits", async () => {
    const summary = await summarize(
      call("edit_file", { path: "a.ts", old_text: "a\nb", new_text: "c" }),
    );

    expect(summary).toBe("Edit a.ts\n- a\n- b\n+ c");
  });

  it("says write_file will create a file that doesn't exist, with the line count", async () => {
    expect(await summarize(call("write_file", { path: "new.ts", content: "a\nb\n" }))).toBe(
      "Write new.ts (create, 2 lines)",
    );
  });

  it("says write_file will replace a file that exists", async () => {
    await project.write("a.ts", "old");

    expect(await summarize(call("write_file", { path: "a.ts", content: "x" }))).toBe(
      "Write a.ts (replace, 1 line)",
    );
  });

  // The tool will refuse it anyway; saying so spares the user a pointless
  // decision and shows why.
  it("says when write_file will be refused", async () => {
    const summary = await summarize(call("write_file", { path: "../x.ts", content: "x" }));

    expect(summary).toMatch(/^Write \.\.\/x\.ts \(will be refused: .*outside the project/);
  });

  it.each([
    ["bash without a command", call("bash", { cmd: "ls" })],
    ["edit_file with a number for old_text", call("edit_file", { path: "a", old_text: 1 })],
    ["write_file without content", call("write_file", { path: "a.ts" })],
    ["a tool it has no summary for", call("read_file", { path: "a.ts" })],
  ])("shows %s as the tool name and its JSON input", async (_name, malformed) => {
    expect(await summarize(malformed)).toBe(
      `${malformed.toolName} ${JSON.stringify(malformed.input)}`,
    );
  });
});
