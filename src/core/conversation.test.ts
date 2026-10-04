import { describe, expect, expectTypeOf, it } from "vitest";
import type { AssistantMessage, Message, Role, ToolCallBlock, ToolResultBlock, UserMessage } from "./conversation.ts";

const createMessage = (message: Message): Message => message;

const readFileCall: ToolCallBlock = {
  type: "tool_call",
  id: "call_1",
  toolName: "read_file",
  input: { path: "a.ts" },
};

const fileNotFound: ToolResultBlock = {
  type: "tool_result",
  toolCallId: "call_1",
  toolCallFailed: true,
  result: "File not found",
};

describe("Messages", () => {
  it("preserves block order", () => {
    const message = createMessage({
      role: "assistant",
      content: [{ type: "text", text: "Let me read it." }, readFileCall],
    });

    expect(message.content).toEqual([{ type: "text", text: "Let me read it." }, readFileCall]);
  });

  it("rejects a message without content", () => {
    createMessage({
      role: "user",
      // @ts-expect-error -- content must have at least one block
      content: [],
    });
  });

  it("can't be emptied or reordered after creation", () => {
    expectTypeOf<UserMessage["content"]>().not.toExtend<unknown[]>();
    expectTypeOf<AssistantMessage["content"]>().not.toExtend<unknown[]>();
  });

  it("only has the roles user and assistant", () => {
    expectTypeOf<Role>().toEqualTypeOf<"user" | "assistant">();
  });
});

describe("Text blocks", () => {
  it("keeps text unchanged", () => {
    const message = createMessage({
      role: "user",
      content: [{ type: "text", text: "Hello\n world" }],
    });

    expect(message.content[0]).toEqual({ type: "text", text: "Hello\n world" });
  });
});

describe("Tool call blocks", () => {
  it("carries a parsed input", () => {
    expectTypeOf(readFileCall.input).toEqualTypeOf<Record<string, unknown>>();

    expect(readFileCall.input.path).toBe("a.ts");
  });

  it("is only valid in assistant messages", () => {
    expectTypeOf<ToolCallBlock>().not.toExtend<UserMessage["content"][number]>();
    expectTypeOf<ToolCallBlock>().toExtend<AssistantMessage["content"][number]>();
  });
});

describe("Tool result blocks", () => {
  it("marks a failed tool result as an error", () => {
    expect(fileNotFound.toolCallId).toBe("call_1");
    expect(fileNotFound.result).toBe("File not found");
    expect(fileNotFound.toolCallFailed).toBe(true);
  });

  it("is only valid in user messages", () => {
    expectTypeOf<ToolResultBlock>().not.toExtend<AssistantMessage["content"][number]>();
    expectTypeOf<ToolResultBlock>().toExtend<UserMessage["content"][number]>();
  });
});
