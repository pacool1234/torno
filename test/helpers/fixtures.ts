import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "anthropic");

export type FixtureName =
  "haiku-text" | "haiku-tool-call" | "haiku-max-tokens" | "haiku-401" | "ollama-thinking-tool-call";

export const FIXTURE_NAMES: readonly FixtureName[] = [
  "haiku-text",
  "haiku-tool-call",
  "haiku-max-tokens",
  "haiku-401",
  "ollama-thinking-tool-call",
];

const metadataSchema = z.object({ status: z.number().int() });

export type Fixture = {
  body: Uint8Array;
  status: number;
};

export function loadFixture(name: FixtureName): Fixture {
  const body = new Uint8Array(readFileSync(join(FIXTURE_DIR, `${name}.sse`)));
  const metadata = metadataSchema.parse(
    JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8")),
  );
  return { body, status: metadata.status };
}

export function chunked(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += size) {
    chunks.push(bytes.subarray(start, start + size));
  }
  return chunks;
}

export function recordedText(bytes: Uint8Array): string {
  const deltaSchema = z.object({
    type: z.literal("content_block_delta"),
    delta: z.object({ type: z.literal("text_delta"), text: z.string() }),
  });
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => deltaSchema.safeParse(JSON.parse(line.slice("data: ".length))))
    .map((parsed) => (parsed.success ? parsed.data.delta.text : ""))
    .join("");
}

export function offsetAfterFirstText(bytes: Uint8Array): number {
  const encoder = new TextEncoder();
  const marker = indexOf(bytes, encoder.encode('"type":"text_delta"'), 0);
  const end = marker === -1 ? -1 : indexOf(bytes, encoder.encode("\n\n"), marker);
  if (end === -1) {
    throw new Error("fixture has no complete text_delta event");
  }
  return end + 2;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.length).indexOf(needle, from);
}
