import { expect } from "vitest";
import type { Message } from "../../src/core/conversation.ts";

export function conversationProblems(conversation: readonly Message[]): string[] {
  const problems: string[] = [];

  if (conversation.length === 0) {
    return ["the conversation is empty"];
  }
  if (conversation[0]?.role !== "user") {
    problems.push("message 0 is not from the user");
  }

  conversation.forEach((message, index) => {
    const previous = conversation[index - 1];
    if (previous !== undefined && previous.role === message.role) {
      problems.push(`messages ${index - 1} and ${index} are both from the ${message.role}`);
    }

    const callIds = message.content.flatMap((block) =>
      block.type === "tool_call" ? [block.id] : [],
    );
    if (callIds.length > 0) {
      const next = conversation[index + 1];
      const resultIds =
        next?.role === "user"
          ? next.content.flatMap((block) =>
              block.type === "tool_result" ? [block.toolCallId] : [],
            )
          : [];
      for (const id of callIds) {
        const count = resultIds.filter((resultId) => resultId === id).length;
        if (count !== 1) {
          problems.push(
            `tool call ${id} in message ${index} has ${count} results in the next message`,
          );
        }
      }
    }

    const previousCallIds = new Set(
      previous?.content.flatMap((block) => (block.type === "tool_call" ? [block.id] : [])) ?? [],
    );
    for (const block of message.content) {
      if (block.type === "tool_result" && !previousCallIds.has(block.toolCallId)) {
        problems.push(
          `tool result for ${block.toolCallId} in message ${index} answers no call in the message before`,
        );
      }
    }
  });

  return problems;
}

export function expectValidConversation(conversation: readonly Message[]): void {
  expect(conversationProblems(conversation)).toEqual([]);
}
