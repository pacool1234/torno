// Shared by every tool: one Zod schema per tool is both the validation of the
// model's input (ADR-0002: untrusted data is parsed at the edge) and the JSON
// Schema the model is shown, so the two can never disagree.

import { z } from "zod";
import type { ToolOutput } from "../../core/ports/tool.ts";

// The JSON Schema for a tool's `inputSchema`. Zod 4 adds a "$schema" key
// naming the JSON Schema dialect; the Messages API doesn't need it, so it's
// left out to keep the tool definitions minimal.
export function inputSchemaOf(schema: z.ZodType): Record<string, unknown> {
  // A spread copy, then `delete` on the copy: toJSONSchema's own object is
  // never modified.
  const jsonSchema: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  delete jsonSchema.$schema;
  return jsonSchema;
}

// Parses the model's input. On failure, returns the error result to send
// back: `prettifyError` lists each problem with its field ("→ at path"), which
// is what the model needs to correct its call.
export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
): { ok: true; value: z.output<S> } | { ok: false; output: ToolOutput } {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return {
    ok: false,
    output: { result: `Invalid input:\n${z.prettifyError(parsed.error)}`, isError: true },
  };
}

// Shorthand for the many places a tool answers with an error.
export const failure = (result: string): ToolOutput => ({ result, isError: true });
