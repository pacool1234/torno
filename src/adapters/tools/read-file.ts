// read_file (spec file-tools, "Reading a file"): returns a text file from the
// project, unchanged, and records it in the read log. Needs no approval
// (ADR-0005: reads inside the project root are allowed).

import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { Tool, ToolOutput } from "../../core/ports/tool.ts";
import type { ReadLog } from "./read-log.ts";
import { failure, inputSchemaOf, parseInput } from "./tool-input.ts";
import type { Workspace } from "./workspace.ts";

// 1 MB: far more than any source file, and a file this size would be cut to
// 30,000 characters by the loop anyway (ADR-0008). Refusing early also avoids
// reading a huge log into memory.
const MAX_BYTES = 1024 * 1024;
// Git's heuristic for "binary": a NUL byte among the first 8,000 or so bytes.
// Text files practically never contain one; images and executables do.
const BINARY_SNIFF_BYTES = 8192;

const inputSchema = z.object({
  path: z.string().min(1).describe("Path of the file, relative to the project root"),
});

// A factory returning a plain object that satisfies the port, rather than a
// class: the tool has no state of its own (the workspace and the log are
// passed in), so a closure is the simplest shape.
export function createReadFile(workspace: Workspace, log: ReadLog): Tool {
  return {
    definition: {
      name: "read_file",
      description:
        "Read a text file in the project and return its contents exactly. Read a file before editing or replacing it.",
      inputSchema: inputSchemaOf(inputSchema),
    },
    needsApproval: false,
    execute: async (input) => {
      const parsed = parseInput(inputSchema, input);
      if (!parsed.ok) {
        return parsed.output;
      }
      const { path } = parsed.value;

      const resolution = await workspace.resolve(path);
      if (!resolution.ok) {
        return failure(resolution.reason);
      }
      return readText(path, resolution.path, log);
    },
  };
}

async function readText(requested: string, resolved: string, log: ReadLog): Promise<ToolOutput> {
  try {
    // `stat` before reading: the size and "is it a directory" are known
    // without loading the file.
    const info = await stat(resolved);
    if (info.isDirectory()) {
      return failure(`"${requested}" is a directory, not a file.`);
    }
    if (info.size > MAX_BYTES) {
      return failure(
        `"${requested}" is too large to read (${info.size} bytes; the limit is ${MAX_BYTES}).`,
      );
    }

    const bytes = await readFile(resolved);
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return failure(`"${requested}" looks binary, so it can't be shown as text.`);
    }

    // Recorded only once the content is actually returned, so a refused file
    // never counts as "read" (it could then be replaced unseen).
    log.record(resolved, bytes);
    return { result: bytes.toString("utf8"), isError: false };
  } catch (error: unknown) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") {
      return failure(`"${requested}" does not exist.`);
    }
    // Permission denied and other I/O problems: a failure the model can read
    // and report, not a crash of the turn.
    return failure(`Could not read "${requested}": ${String(error)}`);
  }
}
