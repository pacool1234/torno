// The session's read log (design D3 of tools-and-repl): which files the model
// has read, and what they contained at that moment. edit_file and write_file
// check it before changing a file, so the model never changes a file it
// hasn't seen, or one that changed after it looked (e.g. edited by the user).

import { createHash } from "node:crypto";

// What a check finds: never read, read but different now, or read as it is.
export type ReadState = "unread" | "changed" | "current";

export class ReadLog {
  // Resolved path → SHA-256 of the bytes. A hash rather than the content:
  // 64 characters per file instead of up to 1 MB, and equal content gives
  // equal hashes, which is all the check needs. Keys are resolved paths
  // (from the workspace), so "a.ts", "./a.ts" and a symlink to it are one
  // entry.
  readonly #hashes = new Map<string, string>();

  record(path: string, content: Buffer): void {
    this.#hashes.set(path, hashOf(content));
  }

  check(path: string, content: Buffer): ReadState {
    const recorded = this.#hashes.get(path);
    if (recorded === undefined) {
      return "unread";
    }
    return recorded === hashOf(content) ? "current" : "changed";
  }
}

// Bytes, not decoded text: decoding could map different bytes (invalid
// UTF-8) to the same text, and the check is about the file as it is on disk.
function hashOf(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
