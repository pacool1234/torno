// write_file and edit_file (spec file-tools): the two tools that change files.
// Both need approval (ADR-0005 level 1), both are confined to the project and
// refuse secret files (through the workspace), and both apply design D3: an
// existing file may only be changed if the model read it, as it is now.

import { isUtf8 } from "node:buffer";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Tool, ToolOutput } from "../../core/ports/tool.ts";
import type { ReadLog } from "./read-log.ts";
import { failure, inputSchemaOf, parseInput } from "./tool-input.ts";
import type { Workspace } from "./workspace.ts";

const writeSchema = z.object({
  path: z.string().min(1).describe("Path of the file, relative to the project root"),
  content: z.string().describe("The file's complete new content"),
});

const editSchema = z.object({
  path: z.string().min(1).describe("Path of the file, relative to the project root"),
  old_text: z
    .string()
    .min(1)
    .describe(
      "Text to replace. Must occur exactly once in the file; include surrounding lines to make it unique",
    ),
  new_text: z.string().describe("Text to put in its place"),
});

export function createWriteFile(workspace: Workspace, log: ReadLog): Tool {
  return {
    definition: {
      name: "write_file",
      description:
        "Create a file, or replace a whole file you have read. Prefer edit_file for changes to existing files.",
      inputSchema: inputSchemaOf(writeSchema),
    },
    needsApproval: true,
    execute: async (input) => {
      const parsed = parseInput(writeSchema, input);
      if (!parsed.ok) {
        return parsed.output;
      }
      const { path, content } = parsed.value;
      const resolution = await workspace.resolve(path);
      if (!resolution.ok) {
        return failure(resolution.reason);
      }
      const target = resolution.path;

      const current = await currentContent(target);
      if (current.kind === "error") {
        return failure(`Could not write "${path}": ${current.message}`);
      }
      if (current.kind === "directory") {
        return failure(`"${path}" is a directory, not a file.`);
      }
      if (current.kind === "special") {
        return failure(notRegular(path));
      }
      // Design D3 applies to replacing only: creating a file can't overwrite
      // anything the model hasn't seen.
      if (current.kind === "file") {
        const refusal = changeRefusal(log, target, current.bytes, path);
        if (refusal !== undefined) {
          return refusal;
        }
      }

      try {
        // Missing parent folders are inside the project: the workspace
        // resolved them through their nearest existing (real, inside)
        // ancestor.
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      } catch (error: unknown) {
        return failure(`Could not write "${path}": ${String(error)}`);
      }
      // The model now knows this file's content (it wrote it), so it counts
      // as read: an edit right after needs no read in between.
      log.record(target, Buffer.from(content));
      const verb = current.kind === "missing" ? "Created" : "Replaced";
      return done(`${verb} "${path}" (${lineCountLabel(content)}).`);
    },
  };
}

export function createEditFile(workspace: Workspace, log: ReadLog): Tool {
  return {
    definition: {
      name: "edit_file",
      description:
        "Replace one exact, unique piece of text in a file you have read. Copy old_text exactly from the file.",
      inputSchema: inputSchemaOf(editSchema),
    },
    needsApproval: true,
    execute: async (input) => {
      const parsed = parseInput(editSchema, input);
      if (!parsed.ok) {
        return parsed.output;
      }
      const { path, old_text: oldText, new_text: newText } = parsed.value;
      if (oldText === newText) {
        return failure("old_text and new_text are identical, so there is nothing to change.");
      }
      const resolution = await workspace.resolve(path);
      if (!resolution.ok) {
        return failure(resolution.reason);
      }
      const target = resolution.path;

      const current = await currentContent(target);
      switch (current.kind) {
        case "missing":
          return failure(`"${path}" does not exist. Use write_file to create it.`);
        case "directory":
          return failure(`"${path}" is a directory, not a file.`);
        case "special":
          return failure(notRegular(path));
        case "error":
          return failure(`Could not read "${path}": ${current.message}`);
        case "file":
          break;
        default: {
          const unhandled: never = current;
          throw new Error(`Unhandled file state: ${JSON.stringify(unhandled)}`);
        }
      }
      const refusal = changeRefusal(log, target, current.bytes, path);
      if (refusal !== undefined) {
        return refusal;
      }

      const text = current.bytes.toString("utf8");
      const matches = countOccurrences(text, oldText);
      if (matches === 0) {
        return failure(`old_text was not found in "${path}". Copy it exactly from the file.`);
      }
      if (matches > 1) {
        return failure(
          `old_text occurs ${matches} times in "${path}". Include more surrounding text so it matches exactly once.`,
        );
      }

      // Slicing, not `text.replace(oldText, newText)`: replace() reads "$&",
      // "$1" and friends in the replacement as patterns, which would corrupt
      // code containing dollar signs (spec "Dollar signs in the replacement").
      const at = text.indexOf(oldText);
      const edited = text.slice(0, at) + newText + text.slice(at + oldText.length);
      try {
        await writeFile(target, edited);
      } catch (error: unknown) {
        return failure(`Could not write "${path}": ${String(error)}`);
      }
      log.record(target, Buffer.from(edited));
      return done(`Edited "${path}".`);
    },
  };
}

// What's at the target now. A union rather than exceptions: each tool
// decides what each case means for it (missing is fine for write_file,
// an error for edit_file).
type CurrentContent =
  | { kind: "missing" }
  | { kind: "directory" }
  // A named pipe, a socket or a device.
  | { kind: "special" }
  | { kind: "file"; bytes: Buffer }
  | { kind: "error"; message: string };

async function currentContent(path: string): Promise<CurrentContent> {
  try {
    // `stat` before reading: opening a named pipe for reading blocks until
    // something writes to it, which nothing will, and the loop can't
    // interrupt a waiting tool.
    const info = await stat(path);
    if (info.isDirectory()) {
      return { kind: "directory" };
    }
    if (!info.isFile()) {
      return { kind: "special" };
    }
    return { kind: "file", bytes: await readFile(path) };
  } catch (error: unknown) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "error", message: String(error) };
  }
}

const notRegular = (path: string): string =>
  `"${path}" is not a regular file (a named pipe or a device, for example).`;

// Why an existing file may not be changed, or undefined if it may.
//
// Encoding first (spec "Only UTF-8 files are changed"): both tools work on
// decoded text, and writing it back would replace every byte that didn't
// decode with U+FFFD, corrupting parts of the file the change never touched.
// Checked before the read log, because reading again wouldn't help.
function changeRefusal(
  log: ReadLog,
  target: string,
  bytes: Buffer,
  path: string,
): ToolOutput | undefined {
  if (!isUtf8(bytes)) {
    return failure(
      `"${path}" is not valid UTF-8 text, and changing it here would corrupt the bytes that aren't. Use bash to change it.`,
    );
  }
  return staleRefusal(log, target, bytes, path);
}

// Design D3's check, worded for the model: what to do next is in the message.
function staleRefusal(
  log: ReadLog,
  target: string,
  bytes: Buffer,
  path: string,
): ToolOutput | undefined {
  switch (log.check(target, bytes)) {
    case "unread":
      return failure(`"${path}" already exists. Read the file first, then change it.`);
    case "changed":
      return failure(`"${path}" changed since you read it. Read it again, then change it.`);
    case "current":
      return undefined;
    default:
      throw new Error("Unhandled read state");
  }
}

// Non-overlapping occurrences, the way indexOf finds them: "aaa" contains
// "aa" once, which matches what the replacement would do.
function countOccurrences(text: string, part: string): number {
  let count = 0;
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + part.length)) {
    count += 1;
  }
  return count;
}

// Lines as an editor shows them: "a\nb\n" and "a\nb" are both 2 lines, ""
// is 0. A final newline ends the last line rather than starting a new one.
export function lineCountLabel(content: string): string {
  if (content === "") {
    return "0 lines";
  }
  const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  return lines === 1 ? "1 line" : `${lines} lines`;
}

const done = (result: string): ToolOutput => ({ result, isError: false });
