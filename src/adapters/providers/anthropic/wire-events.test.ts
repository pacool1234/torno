import { describe, expect, it } from "vitest";
import { type WireEvent, wireEventSchemas } from "./wire-events.ts";

describe("wire event schemas", () => {
  it("accept message_start with usage, ignoring fields torno doesn't use", () => {
    const parsed = wireEventSchemas.message_start.parse({
      type: "message_start",
      message: {
        id: "msg_1",
        model: "claude-haiku-4-5",
        content: [],
        usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 },
      },
    });

    expect(parsed.message.usage).toEqual({
      input_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1000,
    });
    expect(parsed.message).not.toHaveProperty("id");
  });

  it("accept message_start without cache fields, as Ollama sends it", () => {
    const parsed = wireEventSchemas.message_start.parse({
      type: "message_start",
      message: { usage: { input_tokens: 6, output_tokens: 0 } },
    });

    expect(parsed.message.usage.cache_read_input_tokens).toBeUndefined();
  });

  it("accept cache fields that are null", () => {
    const parsed = wireEventSchemas.message_start.parse({
      type: "message_start",
      message: { usage: { input_tokens: 1, cache_read_input_tokens: null } },
    });

    expect(parsed.message.usage.cache_read_input_tokens).toBeNull();
  });

  it("accept a tool_use block start with its id and name", () => {
    const parsed = wireEventSchemas.content_block_start.parse({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
    });

    expect(parsed.content_block).toEqual({ type: "tool_use", id: "toolu_1", name: "read_file" });
  });

  it('accept block types torno doesn\'t support, as an "unsupported" variant', () => {
    const parsed = wireEventSchemas.content_block_start.parse({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "abc" },
    });

    expect(parsed.content_block).toEqual({ type: "unsupported", originalType: "thinking" });
  });

  it("reject a tool_use block start without an id", () => {
    const result = wireEventSchemas.content_block_start.safeParse({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", name: "read_file" },
    });

    expect(result.success).toBe(false);
  });

  it("accept text, partial-JSON and unknown deltas", () => {
    const delta = (body: unknown) =>
      wireEventSchemas.content_block_delta.parse({
        type: "content_block_delta",
        index: 0,
        delta: body,
      }).delta;

    expect(delta({ type: "text_delta", text: "Hi" })).toEqual({ type: "text_delta", text: "Hi" });
    expect(delta({ type: "input_json_delta", partial_json: '{"pa' })).toEqual({
      type: "input_json_delta",
      partial_json: '{"pa',
    });
    expect(delta({ type: "thinking_delta", thinking: "hmm" })).toEqual({
      type: "unsupported",
      originalType: "thinking_delta",
    });
  });

  it("reject a text delta whose text isn't a string", () => {
    const result = wireEventSchemas.content_block_delta.safeParse({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: 42 },
    });

    expect(result.success).toBe(false);
  });

  it("accept message_delta with only output tokens, or with running totals", () => {
    const onlyOutput = wireEventSchemas.message_delta.parse({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 12 },
    });
    const totals = wireEventSchemas.message_delta.parse({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 22, cache_read_input_tokens: 0, output_tokens: 6 },
    });

    expect(onlyOutput.usage).toEqual({ output_tokens: 12 });
    expect(totals.usage).toEqual({
      input_tokens: 22,
      cache_read_input_tokens: 0,
      output_tokens: 6,
    });
  });

  it("accept a stop_reason of null", () => {
    const parsed = wireEventSchemas.message_delta.parse({
      type: "message_delta",
      delta: { stop_reason: null },
      usage: { output_tokens: 1 },
    });

    expect(parsed.delta.stop_reason).toBeNull();
  });

  it("accept an error event with its type and message", () => {
    const parsed = wireEventSchemas.error.parse({
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    });

    expect(parsed.error).toEqual({ type: "overloaded_error", message: "Overloaded" });
  });

  it("reject negative or fractional token counts", () => {
    const usage = (input_tokens: number) =>
      wireEventSchemas.message_start.safeParse({
        type: "message_start",
        message: { usage: { input_tokens } },
      }).success;

    expect(usage(-1)).toBe(false);
    expect(usage(1.5)).toBe(false);
    expect(usage(0)).toBe(true);
  });

  it("let TypeScript narrow a block by its type", () => {
    const idOf = (block: WireEvent<"content_block_start">["content_block"]): string | undefined =>
      block.type === "tool_use" ? block.id : undefined;

    expect(idOf({ type: "tool_use", id: "toolu_1", name: "read_file" })).toBe("toolu_1");
    expect(idOf({ type: "unsupported", originalType: "thinking" })).toBeUndefined();
  });
});
