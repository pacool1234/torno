// The approval summary (design D4 of tools-and-repl): what the REPL shows
// before asking y/N. It lives with the tools rather than in the REPL because
// one detail, whether write_file creates or replaces, needs the file system,
// and the REPL shouldn't touch it. main.ts passes this function to the REPL.

import { stat } from "node:fs/promises";
import { z } from "zod";
import type { ToolCallBlock } from "../../core/conversation.ts";
import { lineCountLabel } from "./change-file.ts";
import type { Workspace } from "./workspace.ts";

// Loose shapes, checked only to pick a format. The approval comes before the
// tool validates its input, so the input here is still the model's raw JSON;
// anything that doesn't fit falls back to showing that JSON as is.
const bashShape = z.object({ command: z.string() });
const editShape = z.object({ path: z.string(), old_text: z.string(), new_text: z.string() });
const writeShape = z.object({ path: z.string(), content: z.string() });

export function createSummarizer(workspace: Workspace): (call: ToolCallBlock) => Promise<string> {
  return async (call) => {
    const fallback = `${call.toolName} ${JSON.stringify(call.input)}`;

    switch (call.toolName) {
      case "bash": {
        const input = bashShape.safeParse(call.input);
        return input.success ? `Run: ${input.data.command}` : fallback;
      }
      case "edit_file": {
        const input = editShape.safeParse(call.input);
        if (!input.success) {
          return fallback;
        }
        const { path, old_text: oldText, new_text: newText } = input.data;
        return [`Edit ${path}`, marked("- ", oldText), marked("+ ", newText)].join("\n");
      }
      case "write_file": {
        const input = writeShape.safeParse(call.input);
        if (!input.success) {
          return fallback;
        }
        const { path, content } = input.data;
        return `Write ${path} (${await writeAction(workspace, path)}, ${lineCountLabel(content)})`;
      }
      default:
        return fallback;
    }
  };
}

// Prefixes every line, like a diff, so a multi-line text's extent is visible.
function marked(marker: string, text: string): string {
  return text
    .split("\n")
    .map((line) => marker + line)
    .join("\n");
}

// "create" or "replace", or why the tool will refuse: the user then knows the
// answer doesn't matter, and why.
async function writeAction(workspace: Workspace, path: string): Promise<string> {
  const resolution = await workspace.resolve(path);
  if (!resolution.ok) {
    return `will be refused: ${resolution.reason}`;
  }
  try {
    await stat(resolution.path);
    return "replace";
  } catch {
    // Doesn't exist (or can't be inspected): writing it would create it.
    return "create";
  }
}
