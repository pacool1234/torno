// Tests for the approver the REPL provides (tools-and-repl, group 5; spec
// repl, "Approval by asking"). The question is asked through an injected
// `ask` function, which in the real REPL is readline's question(): here it's
// a fake that records the question and returns a scripted answer.

import { describe, expect, it } from "vitest";
import type { ToolCallBlock } from "../../core/conversation.ts";
import { PromptApprover } from "./prompt-approver.ts";

const bashCall: ToolCallBlock = {
  type: "tool_call",
  id: "c1",
  toolName: "bash",
  input: { command: "rm -rf build" },
};

function approverAnswering(answer: string) {
  const asked: { question: string; signal: AbortSignal }[] = [];
  const approver = new PromptApprover({
    summarize: (call) => Promise.resolve(`Run: ${String(call.input.command)}`),
    ask: (question, signal) => {
      asked.push({ question, signal });
      return Promise.resolve(answer);
    },
  });
  return { approver, asked };
}

const decide = (answer: string) =>
  approverAnswering(answer).approver.approve(bashCall, new AbortController().signal);

describe("PromptApprover", () => {
  it("asks with the call's summary, and says the default is no", async () => {
    const { approver, asked } = approverAnswering("y");

    await approver.approve(bashCall, new AbortController().signal);

    expect(asked[0]?.question).toBe("Run: rm -rf build\nAllow? [y/N] ");
  });

  it("passes the turn's signal to the question, so Ctrl-C can interrupt it", async () => {
    const { approver, asked } = approverAnswering("y");
    const signal = new AbortController().signal;

    await approver.approve(bashCall, signal);

    expect(asked[0]?.signal).toBe(signal);
  });

  // Spec scenario "Yes".
  it.each(["y", "Y", "yes", "YES", "Yes", "  y  "])("approves %j", async (answer) => {
    expect(await decide(answer)).toBe("approve");
  });

  // Spec scenario "Default is no": anything that isn't clearly yes denies,
  // so a stray key press can't run a command.
  it.each(["", "n", "no", "yeah", "sure", "y es", "ok"])("denies %j", async (answer) => {
    expect(await decide(answer)).toBe("deny");
  });

  // A question interrupted by Ctrl-C rejects; the loop turns that into a
  // cancellation (agent-loop spec), so the approver must not swallow it.
  it("lets an interrupted question's rejection through", async () => {
    const approver = new PromptApprover({
      summarize: () => Promise.resolve("Run: x"),
      ask: () => Promise.reject(new Error("The operation was aborted")),
    });

    await expect(approver.approve(bashCall, new AbortController().signal)).rejects.toThrow(
      "aborted",
    );
  });
});
