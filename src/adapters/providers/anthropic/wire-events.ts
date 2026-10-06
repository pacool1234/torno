import { z } from "zod";

const index = z.number().int().nonnegative();
const tokenCount = z.number().int().nonnegative();
const optionalTokenCount = tokenCount.nullish();

// --- content blocks ---------------------------------------------------------

const textBlock = z.object({ type: z.literal("text") });

const toolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
});

const unsupportedBlock = z
  .object({ type: z.string() })
  .refine((block) => block.type !== "text" && block.type !== "tool_use")
  .transform((block) => ({ type: "unsupported" as const, originalType: block.type }));

// --- deltas -----------------------------------------------------------------

const textDelta = z.object({ type: z.literal("text_delta"), text: z.string() });

const inputJsonDelta = z.object({
  type: z.literal("input_json_delta"),
  partial_json: z.string(),
});

const unsupportedDelta = z
  .object({ type: z.string() })
  .refine((delta) => delta.type !== "text_delta" && delta.type !== "input_json_delta")
  .transform((delta) => ({ type: "unsupported" as const, originalType: delta.type }));

// --- events -----------------------------------------------------------------

export const wireEventSchemas = {
  message_start: z.object({
    type: z.literal("message_start"),
    message: z.object({
      usage: z.object({
        input_tokens: tokenCount,
        cache_creation_input_tokens: optionalTokenCount,
        cache_read_input_tokens: optionalTokenCount,
      }),
    }),
  }),

  content_block_start: z.object({
    type: z.literal("content_block_start"),
    index,
    content_block: z.union([textBlock, toolUseBlock, unsupportedBlock]),
  }),

  content_block_delta: z.object({
    type: z.literal("content_block_delta"),
    index,
    delta: z.union([textDelta, inputJsonDelta, unsupportedDelta]),
  }),

  content_block_stop: z.object({
    type: z.literal("content_block_stop"),
    index,
  }),

  message_delta: z.object({
    type: z.literal("message_delta"),
    delta: z.object({ stop_reason: z.string().nullish() }),
    usage: z.object({
      output_tokens: tokenCount,
      input_tokens: optionalTokenCount,
      cache_creation_input_tokens: optionalTokenCount,
      cache_read_input_tokens: optionalTokenCount,
    }),
  }),

  message_stop: z.object({ type: z.literal("message_stop") }),

  error: z.object({
    type: z.literal("error"),
    error: z.object({ type: z.string(), message: z.string() }),
  }),
};

export type WireEventName = keyof typeof wireEventSchemas;
export type WireEvent<Name extends WireEventName> = z.infer<(typeof wireEventSchemas)[Name]>;
