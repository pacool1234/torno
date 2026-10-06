// Tests for runTurn: turns without tools (group 2), tools and approval
// (group 3).
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
import type { Message, ToolCallBlock } from "./conversation.ts";
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

// The two events a provider emits for one tool call: announced, then complete.
const call = (id: string, toolName: string, input: Record<string, unknown> = {}): StreamEvent[] => [
  { type: "tool_call_started", id, toolName },
  { type: "tool_call_completed", call: { type: "tool_call", id, toolName, input } },
];
const callBlock = (
  id: string,
  toolName: string,
  input: Record<string, unknown> = {},
): ToolCallBlock => ({ type: "tool_call", id, toolName, input });

// A step that asks for the given calls, and a final step that just answers.
const askFor = (...calls: StreamEvent[][]): Script => ({
  events: [...calls.flat(), completed("tool_use")],
});
const answer = (fragment = "Done."): Script => ({ events: [text(fragment), completed()] });

const resultsMessage = (request: { messages: readonly Message[] } | undefined) =>
  request?.messages.at(-1);

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

describe("runTurn: tool calls", () => {
  it("runs a call, sends its result back, and lets the model answer", async () => {
    const readFile = new ScriptedTool("read_file", {
      run: () => ({ result: "file contents", isError: false }),
    });
    const { config } = setup(
      [
        {
          events: [
            text("Let me look."),
            ...call("c1", "read_file", { path: "a.ts" }),
            completed("tool_use"),
          ],
        },
        answer("It's empty."),
      ],
      { tools: [readFile] },
    );

    const { events, ended } = await run(config, "What's in a.ts?");

    const c1 = callBlock("c1", "read_file", { path: "a.ts" });
    const c1Result = {
      type: "tool_result",
      toolCallId: "c1",
      isError: false,
      result: "file contents",
    };
    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "tool_call_started",
      "step_completed",
      "tool_started",
      "tool_finished",
      "text_delta",
      "step_completed",
      "turn_ended",
    ]);
    expect(events).toContainEqual({ type: "tool_started", call: c1 });
    expect(events).toContainEqual({ type: "tool_finished", call: c1, result: c1Result });
    expect(
      events.filter((event) => event.type === "step_completed").map((event) => event.step),
    ).toEqual([1, 2]);
    expect(ended.reason).toBe("completed");
    // The text before the call stays before it, in one assistant message.
    expect(ended.conversation).toEqual([
      user("What's in a.ts?"),
      { role: "assistant", content: [{ type: "text", text: "Let me look." }, c1] },
      { role: "user", content: [c1Result] },
      assistant("It's empty."),
    ]);
  });

  it("passes the call's input and the turn's signal to the tool", async () => {
    const readFile = new ScriptedTool("read_file");
    const { config } = setup([askFor(call("c1", "read_file", { path: "a.ts" })), answer()], {
      tools: [readFile],
    });
    const signal = new AbortController().signal;

    await run(config, "Hi", [], signal);

    expect(readFile.calls).toEqual([{ input: { path: "a.ts" }, signal }]);
    expect(readFile.calls[0]?.signal).toBe(signal);
  });

  // Spec scenario "Second step sees the tool results".
  it("sends the call and its result in the next request", async () => {
    const readFile = new ScriptedTool("read_file", {
      run: () => ({ result: "file contents", isError: false }),
    });
    const { provider, config } = setup([askFor(call("c1", "read_file")), answer()], {
      tools: [readFile],
    });

    await run(config, "Hi");

    expect(provider.requests[1]?.messages.slice(-2)).toEqual([
      { role: "assistant", content: [callBlock("c1", "read_file")] },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "c1", isError: false, result: "file contents" },
        ],
      },
    ]);
  });

  // Spec scenario "Two calls in one step" (ADR-0007: sequential, one message).
  it("runs two calls one after the other, in order, and answers both in one message", async () => {
    const log: string[] = [];
    const slow = new ScriptedTool("slow", {
      log,
      // Finishes on a later tick: if the loop started B without awaiting A,
      // "fast:start" would appear before "slow:end".
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { result: "A", isError: false };
      },
    });
    const fast = new ScriptedTool("fast", { log, run: () => ({ result: "B", isError: false }) });
    const { provider, config } = setup([askFor(call("a", "slow"), call("b", "fast")), answer()], {
      tools: [slow, fast],
    });

    await run(config, "Hi");

    expect(log).toEqual(["slow:start", "slow:end", "fast:start", "fast:end"]);
    expect(resultsMessage(provider.requests[1])).toEqual({
      role: "user",
      content: [
        { type: "tool_result", toolCallId: "a", isError: false, result: "A" },
        { type: "tool_result", toolCallId: "b", isError: false, result: "B" },
      ],
    });
  });

  it("passes a tool's own error result through unchanged", async () => {
    const readFile = new ScriptedTool("read_file", {
      run: () => ({ result: "No such file: a.ts", isError: true }),
    });
    const { provider, config } = setup([askFor(call("c1", "read_file")), answer()], {
      tools: [readFile],
    });

    await run(config, "Hi");

    expect(resultsMessage(provider.requests[1])?.content).toEqual([
      { type: "tool_result", toolCallId: "c1", isError: true, result: "No such file: a.ts" },
    ]);
  });

  // Spec scenario "Unknown tool".
  it("answers a call to an unknown tool with an error, without running anything", async () => {
    const readFile = new ScriptedTool("read_file");
    const { provider, config } = setup([askFor(call("c1", "delete_everything")), answer()], {
      tools: [readFile],
    });

    const { events, ended } = await run(config, "Hi");

    expect(readFile.calls).toEqual([]);
    expect(events.some((event) => event.type === "tool_started")).toBe(false);
    const [result] = resultsMessage(provider.requests[1])?.content ?? [];
    expect(result).toMatchObject({ type: "tool_result", toolCallId: "c1", isError: true });
    expect(result?.type === "tool_result" && result.result).toContain("delete_everything");
    expect(provider.requests).toHaveLength(2);
    expect(ended.reason).toBe("completed");
  });

  // Spec scenario "Tool throws".
  it.each([
    ["an Error", new Error("disk full")],
    ["a non-Error value", "disk full"],
  ])("answers with an error result when the tool throws %s", async (_name, thrown) => {
    const writeFile = new ScriptedTool("write_file", {
      run: () => {
        // Deliberate: JavaScript can throw any value, and the loop must cope
        // with a non-Error one too, so this test throws a plain string.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw thrown;
      },
    });
    const { provider, config } = setup([askFor(call("c1", "write_file")), answer()], {
      tools: [writeFile],
    });

    const { events } = await run(config, "Hi");

    const finished = events.find((event) => event.type === "tool_finished");
    expect(finished?.result.isError).toBe(true);
    // Exact text: the same message whatever was thrown, with no "Error: "
    // prefix that String(error) would add for an Error object.
    expect(finished?.result.result).toBe("The tool failed: disk full");
    expect(provider.requests).toHaveLength(2);
  });

  // A "tool_use" stop reason with no complete call is a provider quirk; there
  // is nothing to run, so the turn simply ends (design, "Choices that follow").
  it("ends the turn when the stop reason is tool_use but there are no calls", async () => {
    const { provider, config } = setup([{ events: [text("Hmm."), completed("tool_use")] }]);

    const { ended } = await run(config, "Hi");

    expect(ended.reason).toBe("completed");
    expect(provider.requests).toHaveLength(1);
  });
});

describe("runTurn: approval", () => {
  // Spec scenario "Read without asking".
  it("runs a tool that doesn't need approval without asking", async () => {
    const approver = new ScriptedApprover();
    const readFile = new ScriptedTool("read_file", { needsApproval: false });
    const { config } = setup([askFor(call("c1", "read_file")), answer()], {
      tools: [readFile],
      approver,
    });

    await run(config, "Hi");

    expect(approver.asked).toEqual([]);
    expect(readFile.calls).toHaveLength(1);
  });

  it("asks before a tool that needs approval, with the call and the signal, and runs it when approved", async () => {
    const signals: AbortSignal[] = [];
    const approver = new ScriptedApprover((_call, signal) => {
      signals.push(signal);
      return "approve";
    });
    const bash = new ScriptedTool("bash", { needsApproval: true });
    const { config } = setup([askFor(call("c1", "bash", { command: "ls" })), answer()], {
      tools: [bash],
      approver,
    });
    const signal = new AbortController().signal;

    await run(config, "Hi", [], signal);

    expect(approver.asked).toEqual([callBlock("c1", "bash", { command: "ls" })]);
    expect(signals[0]).toBe(signal);
    expect(bash.calls).toHaveLength(1);
  });

  // Spec scenario "Denied call".
  it("doesn't run a denied call, tells the model, and continues", async () => {
    const bash = new ScriptedTool("bash", { needsApproval: true });
    const { provider, config } = setup([askFor(call("c1", "bash")), answer()], {
      tools: [bash],
      approver: new ScriptedApprover(() => "deny"),
    });

    const { events, ended } = await run(config, "Hi");

    const denied = {
      type: "tool_result",
      toolCallId: "c1",
      isError: true,
      result: "The user denied this tool call.",
    };
    expect(bash.calls).toEqual([]);
    expect(events.some((event) => event.type === "tool_started")).toBe(false);
    expect(events).toContainEqual({
      type: "tool_finished",
      call: callBlock("c1", "bash"),
      result: denied,
    });
    expect(resultsMessage(provider.requests[1])?.content).toEqual([denied]);
    expect(ended.reason).toBe("completed");
  });

  it("asks about each call separately, and a denial doesn't stop the next call", async () => {
    const approver = new ScriptedApprover((asked) => (asked.id === "a" ? "deny" : "approve"));
    const bash = new ScriptedTool("bash", { needsApproval: true });
    const { provider, config } = setup([askFor(call("a", "bash"), call("b", "bash")), answer()], {
      tools: [bash],
      approver,
    });

    await run(config, "Hi");

    expect(approver.asked.map((asked) => asked.id)).toEqual(["a", "b"]);
    expect(bash.calls).toHaveLength(1);
    expect(
      resultsMessage(provider.requests[1])?.content.map(
        (block) => block.type === "tool_result" && block.isError,
      ),
    ).toEqual([true, false]);
  });
});
