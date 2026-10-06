import { describe, expect, it } from "vitest";
import type { Message } from "../../src/core/conversation.ts";
import { conversationProblems } from "./valid-conversation.ts";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const calls = (...ids: string[]): Message => ({
  role: "assistant",
  content: [
    { type: "text", text: "Let me look." },
    ...ids.map((id) => ({ type: "tool_call" as const, id, toolName: "read_file", input: {} })),
  ],
});
const results = (...ids: string[]): Message => ({
  role: "user",
  content: ids.map((id) => ({
    type: "tool_result" as const,
    toolCallId: id,
    isError: false,
    result: "ok",
  })) as unknown as Extract<Message, { role: "user" }>["content"],
});

describe("conversationProblems", () => {
  it.each<[string, Message[]]>([
    ["a question and an answer", [user("Hi"), assistant("Hello")]],
    ["only the prompt (stopped before any answer)", [user("Hi")]],
    ["a tool round trip", [user("Hi"), calls("a", "b"), results("b", "a"), assistant("Done")]],
    ["ending with tool results (step limit)", [user("Hi"), calls("a"), results("a")]],
    [
      "results followed by a prompt in the same message",
      [
        user("Hi"),
        calls("a"),
        {
          role: "user",
          content: [
            { type: "tool_result", toolCallId: "a", isError: true, result: "Not run" },
            { type: "text", text: "continue" },
          ],
        },
      ],
    ],
  ])("accepts %s", (_name, conversation) => {
    expect(conversationProblems(conversation)).toEqual([]);
  });

  it.each<[string, Message[], string]>([
    ["an empty conversation", [], "empty"],
    ["one starting with the assistant", [assistant("Hello"), user("Hi")], "message 0"],
    ["two user messages in a row", [user("Hi"), user("Hi again")], "both from the user"],
    ["a call with no result", [user("Hi"), calls("a"), results(), assistant("Done")], "0 results"],
    ["a call as the last message", [user("Hi"), calls("a")], "0 results"],
    ["a call answered twice", [user("Hi"), calls("a"), results("a", "a")], "2 results"],
    [
      "a result for an unknown call",
      [user("Hi"), calls("a"), results("a", "z")],
      "answers no call",
    ],
    [
      "a result with no call before it",
      [user("Hi"), assistant("Hello"), results("a")],
      "answers no call",
    ],
  ])("rejects %s", (_name, conversation, problem) => {
    const problems = conversationProblems(conversation);

    expect(problems.some((text) => text.includes(problem))).toBe(true);
  });
});
