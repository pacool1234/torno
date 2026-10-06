// Tests for runTurn, group 2 of the agent-loop change: turns without tools.
// Every test runs offline against ScriptedProvider (ADR-0001), and every test
// that ends a turn checks the conversation invariant of design D2.

import { describe, expect, it } from "vitest";
import { ScriptedProvider, type Script } from "../adapters/providers/fake/scripted-provider.ts";
import { consume } from "../../test/helpers/consume.ts";
import { ScriptedApprover } from "../../test/helpers/scripted-approver.ts";
import { ScriptedTool } from "../../test/helpers/scripted-tool.ts";
import { expectValidConversation } from "../../test/helpers/valid-conversation.ts";
import type { AgentConfig, AgentEvent, TurnEnded } from "./agent.ts";
import { runTurn } from "./agent-loop.ts";
import type { Message } from "./conversation.ts";
import type { StopReason, StreamEvent } from "./ports/model-provider.ts";

const USAGE = { inputTokens: 12, outputTokens: 5 };

const text = (fragment: string): StreamEvent => ({ type: "text_delta", text: fragment });
const completed = (stopReason: StopReason = "end_turn"): StreamEvent => ({
  type: "response_completed",
  stopReason,
  usage: USAGE,
  skippedBlocks: 0,
});

// Builds a config around a ScriptedProvider playing `scripts` in order (one
// per step), with test-friendly limits. `overrides` replaces any field.
function setup(scripts: Script[], overrides: Partial<AgentConfig> = {}) {
  const provider = new ScriptedProvider(scripts);
  const config: AgentConfig = {
    provider,
    tools: [],
    approver: new ScriptedApprover(),
    model: "test-model",
    maxOutputTokens: 1000,
    maxSteps: 5,
    ...overrides,
  };
  return { provider, config };
}

async function run(
  config: AgentConfig,
  prompt: string,
  conversation: readonly Message[] = [],
  signal: AbortSignal = new AbortController().signal,
) {
  const { events, error } = await consume(runTurn(config, conversation, prompt, signal));
  // runTurn never throws for expected outcomes (design D1), so an error here
  // is a bug: fail loudly instead of letting a test check events of a crash.
  expect(error).toBeUndefined();
  return { events, ended: lastTurnEnded(events) };
}

// The spec's "ends with exactly one turn_ended" rule, checked on every run.
function lastTurnEnded(events: AgentEvent[]): TurnEnded {
  expect(events.filter((event) => event.type === "turn_ended")).toHaveLength(1);
  const last = events.at(-1);
  if (last?.type !== "turn_ended") {
    throw new Error(`expected turn_ended last, got ${last?.type ?? "no events"}`);
  }
  expectValidConversation(last.conversation);
  return last;
}

const user = (textValue: string): Message => ({
  role: "user",
  content: [{ type: "text", text: textValue }],
});
const assistant = (textValue: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text: textValue }],
});

describe("runTurn: a turn without tools", () => {
  // Spec scenario "Text-only answer".
  it("streams the text, completes the step, and ends with the answer added", async () => {
    const { config } = setup([{ events: [text("Hel"), text("lo"), completed()] }]);

    const { events } = await run(config, "Hi");

    expect(events).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      {
        type: "step_completed",
        step: 1,
        stopReason: "end_turn",
        usage: USAGE,
        skippedBlocks: 0,
      },
      {
        type: "turn_ended",
        reason: "completed",
        // The fragments joined into one text block: the conversation stores
        // what the model said, not how it happened to be streamed.
        conversation: [user("Hi"), assistant("Hello")],
      },
    ]);
  });

  // `other` covers stop reasons torno doesn't act on (refusal, pause_turn,
  // ...): the model stopped, so the turn is over.
  it.each<StopReason>(["end_turn", "other"])(
    "ends as completed on stop reason %s",
    async (stop) => {
      const { config } = setup([{ events: [text("Done."), completed(stop)] }]);

      const { ended } = await run(config, "Hi");

      expect(ended.reason).toBe("completed");
    },
  );

  it("makes exactly one model request when the model doesn't ask for tools", async () => {
    const { provider, config } = setup([{ events: [text("Hi!"), completed()] }]);

    await run(config, "Hi");

    expect(provider.requests).toHaveLength(1);
  });

  // Spec scenario "Empty response": an assistant message can't be empty
  // (NonEmptyArray), so nothing is added rather than an invalid message.
  it("adds no assistant message when the response is empty", async () => {
    const { config } = setup([{ events: [completed()] }]);

    const { ended } = await run(config, "Hi");

    expect(ended.reason).toBe("completed");
    expect(ended.conversation).toEqual([user("Hi")]);
  });
});

describe("runTurn: the request sent to the model", () => {
  it("sends the model, system, tool definitions, output limit, signal and conversation", async () => {
    const readFile = new ScriptedTool("read_file");
    const { provider, config } = setup([{ events: [completed()] }], {
      tools: [readFile],
      system: "You are torno.",
    });
    const signal = new AbortController().signal;
    const history = [user("Earlier"), assistant("Sure")];

    await run(config, "Hi", history, signal);

    expect(provider.requests[0]).toEqual({
      model: "test-model",
      system: "You are torno.",
      tools: [readFile.definition],
      maxOutputTokens: 1000,
      messages: [...history, user("Hi")],
      signal,
    });
    // Same object, not just an equal one: cancelling the turn must cancel
    // this very request.
    expect(provider.requests[0]?.signal).toBe(signal);
  });

  it("sends no system key when there are no system instructions", async () => {
    const { provider, config } = setup([{ events: [completed()] }]);

    await run(config, "Hi");

    expect(provider.requests[0]).not.toHaveProperty("system");
  });

  // Spec scenario "Conversation ending with a user message".
  it("appends the prompt to a trailing user message instead of adding a second one", async () => {
    const { provider, config } = setup([{ events: [completed()] }]);
    const history: Message[] = [
      user("Read a.ts"),
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "call_1", toolName: "read_file", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolCallId: "call_1", isError: true, result: "Not run" }],
      },
    ];

    await run(config, "continue", history);

    expect(provider.requests[0]?.messages).toEqual([
      history[0],
      history[1],
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "call_1", isError: true, result: "Not run" },
          { type: "text", text: "continue" },
        ],
      },
    ]);
  });

  // The caller owns the conversation (design D1): runTurn returns a new one
  // and leaves the one it was given untouched, so the REPL can keep the old
  // history if it wants to.
  it("doesn't modify the conversation it was given", async () => {
    const { config } = setup([{ events: [text("Hello"), completed()] }]);
    const history: Message[] = [user("Earlier"), assistant("Sure")];
    const before = structuredClone(history);

    await run(config, "Hi", history);

    expect(history).toEqual(before);
  });
});
