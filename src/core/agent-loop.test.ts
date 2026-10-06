// Tests for runTurn: turns without tools (group 2), tools and approval
// (group 3), limits and failures (group 4), cancellation (group 5).
// Every test runs offline against ScriptedProvider (ADR-0001), and every test
// that ends a turn checks the conversation invariant of design D2.

import { describe, expect, it } from "vitest";
import { ScriptedProvider, type Script } from "../adapters/providers/fake/scripted-provider.ts";
import { consume } from "../../test/helpers/consume.ts";
import { ScriptedApprover } from "../../test/helpers/scripted-approver.ts";
import { ScriptedTool, untilAborted } from "../../test/helpers/scripted-tool.ts";
import { expectValidConversation } from "../../test/helpers/valid-conversation.ts";
import type { AgentConfig, AgentEvent, TurnEnded } from "./agent.ts";
import { runTurn } from "./agent-loop.ts";
import type { Message, ToolCallBlock } from "./conversation.ts";
import { ProviderError, type StopReason, type StreamEvent } from "./ports/model-provider.ts";

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

describe("runTurn: the step limit", () => {
  // Spec scenario "Step limit".
  it("stops after maxSteps requests, keeping the last step's tool results", async () => {
    const readFile = new ScriptedTool("read_file");
    // A third script that must never be used: if the loop made a third
    // request, the turn would complete instead of hitting the limit.
    const { provider, config } = setup(
      [askFor(call("c1", "read_file")), askFor(call("c2", "read_file")), answer()],
      { tools: [readFile], maxSteps: 2 },
    );

    const { ended } = await run(config, "Hi");

    expect(provider.requests).toHaveLength(2);
    expect(readFile.calls).toHaveLength(2);
    expect(ended.reason).toBe("step_limit");
    // The conversation ends with step 2's results, so typing "continue"
    // resumes exactly where the loop stopped.
    expect(ended.conversation.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", toolCallId: "c2", isError: false, result: "read_file done" },
      ],
    });
  });

  it("completes normally when the model answers on the last allowed step", async () => {
    const { config } = setup([askFor(call("c1", "read_file")), answer()], {
      tools: [new ScriptedTool("read_file")],
      maxSteps: 2,
    });

    const { ended } = await run(config, "Hi");

    expect(ended.reason).toBe("completed");
  });
});

describe("runTurn: the output limit", () => {
  // Spec scenario "Output limit".
  it("ends with max_tokens, keeping the cut text", async () => {
    const { provider, config } = setup([{ events: [text("The answer"), completed("max_tokens")] }]);

    const { ended } = await run(config, "Hi");

    expect(ended.reason).toBe("max_tokens");
    expect(ended.conversation.at(-1)).toEqual(assistant("The answer"));
    expect(provider.requests).toHaveLength(1);
  });

  // Complete calls in a cut response aren't run (the model may have meant
  // more), but each still needs a result for the conversation to be valid.
  it("doesn't run calls from a cut response, and answers each with an error", async () => {
    const readFile = new ScriptedTool("read_file");
    const { config } = setup(
      [{ events: [...call("c1", "read_file"), text("And then"), completed("max_tokens")] }],
      { tools: [readFile] },
    );

    const { events, ended } = await run(config, "Hi");

    const notRun = {
      type: "tool_result",
      toolCallId: "c1",
      isError: true,
      result: "Not run: the response hit the output limit.",
    };
    expect(readFile.calls).toEqual([]);
    expect(events.some((event) => event.type === "tool_started")).toBe(false);
    expect(events).toContainEqual({
      type: "tool_finished",
      call: callBlock("c1", "read_file"),
      result: notRun,
    });
    expect(ended.reason).toBe("max_tokens");
    expect(ended.conversation.at(-1)).toEqual({ role: "user", content: [notRun] });
  });
});

describe("runTurn: provider failures", () => {
  // Spec scenario "Failure in the second step".
  it("ends with failed and the error, keeping finished steps and dropping the failed one", async () => {
    const { provider, config } = setup(
      [
        askFor(call("c1", "read_file")),
        { events: [text("Half an ans")], ending: { type: "fail", kind: "overloaded" } },
      ],
      { tools: [new ScriptedTool("read_file")] },
    );

    const { events, ended } = await run(config, "Hi");

    expect(ended.reason).toBe("failed");
    if (ended.reason !== "failed") {
      return;
    }
    expect(ended.error).toBeInstanceOf(ProviderError);
    expect(ended.error.kind).toBe("overloaded");
    expect(provider.requests).toHaveLength(2);
    // The text was shown as it streamed...
    expect(events).toContainEqual({ type: "text_delta", text: "Half an ans" });
    // ...but isn't kept (design D2): the conversation ends with step 1's result.
    expect(ended.conversation).toEqual([
      user("Hi"),
      { role: "assistant", content: [callBlock("c1", "read_file")] },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "c1", isError: false, result: "read_file done" },
        ],
      },
    ]);
  });

  // ADR-0007: no retries, even for kinds the port classifies as retryable.
  it.each(["rate_limit", "overloaded", "network", "timeout", "auth"] as const)(
    "doesn't retry: %s",
    async (kind) => {
      const { provider, config } = setup([
        { events: [], ending: { type: "fail", kind } },
        answer(),
      ]);

      const { ended } = await run(config, "Hi");

      expect(ended.reason).toBe("failed");
      expect(provider.requests).toHaveLength(1);
      expect(ended.conversation).toEqual([user("Hi")]);
    },
  );

  // Design D1: only bugs throw. ScriptedProvider with no script left throws a
  // plain Error, which stands in for a bug in an adapter.
  it("lets an error that isn't a ProviderError propagate", async () => {
    const { config } = setup([]);

    const { error } = await consume(runTurn(config, [], "Hi", new AbortController().signal));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProviderError);
  });
});

// Runs a turn and aborts its signal as soon as `when` matches an event: the
// way Ctrl-C lands at an arbitrary point. The abort happens while the loop is
// paused at that `yield`, so everything after it sees an aborted signal.
async function runCancelling(
  config: AgentConfig,
  when: (event: AgentEvent) => boolean,
  conversation: readonly Message[] = [],
) {
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  for await (const event of runTurn(config, conversation, "Hi", controller.signal)) {
    events.push(event);
    if (when(event)) {
      controller.abort();
    }
  }
  return { events, ended: lastTurnEnded(events), signal: controller.signal };
}

const NOT_RUN_CANCELLED = "Not run: the user cancelled.";
const cancelledResult = (id: string) => ({
  type: "tool_result",
  toolCallId: id,
  isError: true,
  result: NOT_RUN_CANCELLED,
});

describe("runTurn: cancellation", () => {
  it("cancelled before starting: no request, and the prompt is kept", async () => {
    const { provider, config } = setup([answer()]);
    const controller = new AbortController();
    controller.abort();

    const { ended } = await run(config, "Hi", [], controller.signal);

    expect(ended.reason).toBe("cancelled");
    expect(provider.requests).toEqual([]);
    expect(ended.conversation).toEqual([user("Hi")]);
  });

  // Spec scenario "Cancelled while streaming".
  it("cancelled while streaming: the partial response is dropped", async () => {
    const { provider, config } = setup([
      { events: [text("Hel"), text("lo")], ending: { type: "hang" } },
    ]);

    const { events, ended } = await runCancelling(config, (event) => event.type === "text_delta");

    expect(events.map((event) => event.type)).toEqual(["text_delta", "turn_ended"]);
    expect(ended.reason).toBe("cancelled");
    expect(ended.conversation).toEqual([user("Hi")]);
    expect(provider.openStreams).toBe(0);
  });

  it("cancelled after a response asked for tools: the response stays, its calls don't run", async () => {
    const readFile = new ScriptedTool("read_file");
    const { provider, config } = setup(
      [askFor(call("a", "read_file"), call("b", "read_file")), answer()],
      {
        tools: [readFile],
      },
    );

    const { events, ended } = await runCancelling(
      config,
      (event) => event.type === "step_completed",
    );

    expect(readFile.calls).toEqual([]);
    expect(events.some((event) => event.type === "tool_started")).toBe(false);
    expect(ended.reason).toBe("cancelled");
    expect(provider.requests).toHaveLength(1);
    expect(ended.conversation).toEqual([
      user("Hi"),
      { role: "assistant", content: [callBlock("a", "read_file"), callBlock("b", "read_file")] },
      { role: "user", content: [cancelledResult("a"), cancelledResult("b")] },
    ]);
  });

  // Spec scenario "Cancelled while a tool runs".
  it("cancelled while a tool runs: its outcome is kept, later calls don't run", async () => {
    const bash = new ScriptedTool("bash", { run: untilAborted("stopped by Ctrl-C") });
    const readFile = new ScriptedTool("read_file");
    const { provider, config } = setup(
      [askFor(call("a", "bash"), call("b", "read_file")), answer()],
      {
        tools: [bash, readFile],
      },
    );

    const { ended, signal } = await runCancelling(config, (event) => event.type === "tool_started");

    // The running tool got the turn's signal, and saw it abort.
    expect(bash.calls[0]?.signal).toBe(signal);
    expect(bash.calls[0]?.signal.aborted).toBe(true);
    expect(readFile.calls).toEqual([]);
    expect(provider.requests).toHaveLength(1);
    expect(ended.reason).toBe("cancelled");
    expect(ended.conversation.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", toolCallId: "a", isError: true, result: "stopped by Ctrl-C" },
        cancelledResult("b"),
      ],
    });
  });

  // Spec scenario "Cancelled at the approval prompt". Two approver styles:
  // one that rejects when the signal aborts (a REPL prompt interrupted by
  // Ctrl-C), and one that ignores it and answers anyway. Both must cancel.
  it.each([
    [
      "rejects",
      (_call: ToolCallBlock, signal: AbortSignal) =>
        new Promise<"approve">((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("prompt interrupted")), {
            once: true,
          });
        }),
    ],
    [
      "approves anyway",
      (_call: ToolCallBlock, signal: AbortSignal) =>
        new Promise<"approve">((resolve) => {
          signal.addEventListener("abort", () => resolve("approve"), { once: true });
        }),
    ],
  ])("cancelled at the approval prompt (the approver %s): nothing runs", async (_name, decide) => {
    const controller = new AbortController();
    const bash = new ScriptedTool("bash", { needsApproval: true });
    const approver = new ScriptedApprover((asked, signal) => {
      // Ctrl-C lands while the question is open.
      queueMicrotask(() => controller.abort());
      return decide(asked, signal);
    });
    const { provider, config } = setup([askFor(call("a", "bash"), call("b", "bash")), answer()], {
      tools: [bash],
      approver,
    });

    const { ended } = await run(config, "Hi", [], controller.signal);

    expect(bash.calls).toEqual([]);
    expect(approver.asked.map((asked) => asked.id)).toEqual(["a"]);
    expect(provider.requests).toHaveLength(1);
    expect(ended.reason).toBe("cancelled");
    expect(ended.conversation.at(-1)).toEqual({
      role: "user",
      content: [cancelledResult("a"), cancelledResult("b")],
    });
  });

  // An approver that fails without a cancellation is a bug in the approver
  // (design D1: bugs throw), not a reason to end the turn quietly.
  it("lets an approver's error propagate when the turn wasn't cancelled", async () => {
    const { config } = setup([askFor(call("a", "bash")), answer()], {
      tools: [new ScriptedTool("bash", { needsApproval: true })],
      approver: new ScriptedApprover(() => {
        throw new Error("terminal closed");
      }),
    });

    const { error } = await consume(runTurn(config, [], "Hi", new AbortController().signal));

    expect(error).toMatchObject({ message: "terminal closed" });
  });

  // Ctrl-C and the step limit in the same step: the cancellation is reported,
  // since it's what the user just did. (Without the check right after the
  // tools, the limit would be reported, and the next step's check would
  // never run.)
  it("reports cancelled, not step_limit, when both happen in the last step", async () => {
    const { config } = setup([askFor(call("a", "bash"))], {
      tools: [new ScriptedTool("bash", { run: untilAborted() })],
      maxSteps: 1,
    });

    const { ended } = await runCancelling(config, (event) => event.type === "tool_started");

    expect(ended.reason).toBe("cancelled");
  });

  // Same rule as the port's "cancelled after completion": once the model has
  // ended its turn, there's nothing left to cancel.
  it("a cancellation after the final answer still ends as completed", async () => {
    const { config } = setup([answer("All done.")]);

    const { ended } = await runCancelling(config, (event) => event.type === "step_completed");

    expect(ended.reason).toBe("completed");
    expect(ended.conversation.at(-1)).toEqual(assistant("All done."));
  });
});

// ADR-0008: one huge tool result must not make every later request too long
// for the model, so the loop caps results, keeping the head and the tail.
describe("runTurn: tool results are capped", () => {
  async function resultFor(output: string) {
    const bash = new ScriptedTool("bash", { run: () => ({ result: output, isError: false }) });
    const { provider, config } = setup([askFor(call("c1", "bash")), answer()], { tools: [bash] });
    const { events } = await run(config, "Hi");
    const finished = events.find((event) => event.type === "tool_finished");
    const sent = resultsMessage(provider.requests[1])?.content[0];
    // The event and the request carry the same capped text: the REPL shows
    // exactly what the model saw.
    expect(sent).toEqual(finished?.result);
    return finished?.result.result ?? "";
  }

  // Spec scenario "Large output". Three distinct letters, so the test can see
  // which parts were kept and which were cut.
  it("keeps the first and last 15,000 characters of a longer result, with a note", async () => {
    const output = "A".repeat(15_000) + "M".repeat(70_000) + "Z".repeat(15_000);

    const result = await resultFor(output);

    expect(result.startsWith("A".repeat(15_000))).toBe(true);
    expect(result.endsWith("Z".repeat(15_000))).toBe(true);
    expect(result).not.toContain("M");
    expect(result).toContain("70000 characters left out");
  });

  it.each([
    ["exactly at the cap", 30_000],
    ["under the cap", 12],
  ])("leaves a result %s unchanged", async (_name, length) => {
    const output = "x".repeat(length);

    expect(await resultFor(output)).toBe(output);
  });

  it("caps a result one character over the cap", async () => {
    expect(await resultFor("x".repeat(30_001))).toContain("1 characters left out");
  });

  // Spec scenario "Emoji at the cut". "😀" is two UTF-16 code units (a
  // surrogate pair); cutting between them leaves half a character, which
  // isn't valid text and may be rejected when sent to the model.
  it.each([
    ["the head's end", "a".repeat(14_999) + "😀" + "b".repeat(100_000)],
    ["the tail's start", "a".repeat(100_000) + "😀" + "b".repeat(14_999)],
  ])("never splits a surrogate pair at %s", async (_name, output) => {
    const result = await resultFor(output);

    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    expect(loneSurrogate.test(result)).toBe(false);
  });
});

// Review nit: maxSteps below 1 would still make one request, breaking "at
// most maxSteps". It's a configuration bug, so it throws (design D1).
describe("runTurn: configuration", () => {
  it.each([0, -1, 1.5])("rejects maxSteps %s", async (maxSteps) => {
    const { provider, config } = setup([answer()], { maxSteps });

    const { error } = await consume(runTurn(config, [], "Hi", new AbortController().signal));

    expect(error).toBeInstanceOf(RangeError);
    expect(provider.requests).toEqual([]);
  });
});

// Spec scenario "Every ending" (task 5.3). `lastTurnEnded` checks the
// invariant on every run in this file already; this table states it in one
// place, and makes sure each reason really is reached by some setup. Each
// case uses a tool round trip first where it can, so the conversation has
// calls and results to get wrong.
describe("runTurn: the returned conversation is valid whatever the ending", () => {
  const readFile = () => new ScriptedTool("read_file");

  it.each<[TurnEnded["reason"], () => Promise<TurnEnded>]>([
    [
      "completed",
      async () => {
        const { config } = setup([askFor(call("a", "read_file")), answer()], {
          tools: [readFile()],
        });
        return (await run(config, "Hi")).ended;
      },
    ],
    [
      "step_limit",
      async () => {
        const { config } = setup([askFor(call("a", "read_file"))], {
          tools: [readFile()],
          maxSteps: 1,
        });
        return (await run(config, "Hi")).ended;
      },
    ],
    [
      "max_tokens",
      async () => {
        const { config } = setup(
          [
            askFor(call("a", "read_file")),
            { events: [...call("b", "read_file"), completed("max_tokens")] },
          ],
          { tools: [readFile()] },
        );
        return (await run(config, "Hi")).ended;
      },
    ],
    [
      "failed",
      async () => {
        const { config } = setup(
          [
            askFor(call("a", "read_file")),
            { events: [text("Hal")], ending: { type: "fail", kind: "network" } },
          ],
          { tools: [readFile()] },
        );
        return (await run(config, "Hi")).ended;
      },
    ],
    [
      "cancelled",
      async () => {
        const { config } = setup([askFor(call("a", "read_file"), call("b", "read_file"))], {
          tools: [new ScriptedTool("read_file", { run: untilAborted() })],
        });
        return (await runCancelling(config, (event) => event.type === "tool_started")).ended;
      },
    ],
  ])("%s", async (reason, endTurn) => {
    const ended = await endTurn();

    expect(ended.reason).toBe(reason);
    expectValidConversation(ended.conversation);
  });
});
