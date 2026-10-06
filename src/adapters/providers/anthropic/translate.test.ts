import { describe, expect, it } from "vitest";
import {
  ProviderError,
  type ProviderErrorKind,
  type StreamEvent,
} from "../../../core/ports/model-provider.ts";
import { consume } from "../../../../test/helpers/consume.ts";
import type { ServerSentEvent } from "./event-stream.ts";
import { translateStream } from "./translate.ts";

const sse = (event: string, data: unknown): ServerSentEvent => ({
  event,
  data: JSON.stringify(data),
});

const messageStart = (usage: Record<string, unknown> = { input_tokens: 10 }) =>
  sse("message_start", { type: "message_start", message: { usage } });

const blockStart = (index: number, contentBlock: Record<string, unknown>) =>
  sse("content_block_start", { type: "content_block_start", index, content_block: contentBlock });

const textStart = (index: number) => blockStart(index, { type: "text", text: "" });
const toolStart = (index: number, id: string, name: string) =>
  blockStart(index, { type: "tool_use", id, name, input: {} });

const delta = (index: number, body: Record<string, unknown>) =>
  sse("content_block_delta", { type: "content_block_delta", index, delta: body });

const textDelta = (index: number, text: string) => delta(index, { type: "text_delta", text });
const jsonDelta = (index: number, partial: string) =>
  delta(index, { type: "input_json_delta", partial_json: partial });

const blockStop = (index: number) =>
  sse("content_block_stop", { type: "content_block_stop", index });

const messageDelta = (
  stopReason: string | null,
  usage: Record<string, unknown> = { output_tokens: 5 },
) => sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage });

const messageStop = () => sse("message_stop", { type: "message_stop" });

const textAnswer = (...fragments: string[]): ServerSentEvent[] => [
  messageStart(),
  textStart(0),
  ...fragments.map((fragment) => textDelta(0, fragment)),
  blockStop(0),
  messageDelta("end_turn"),
  messageStop(),
];

function source(events: ServerSentEvent[]) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<ServerSentEvent>(
    {
      pull(controller) {
        const next = events[state.pulled];
        if (next === undefined) {
          controller.close();
          return;
        }
        state.pulled += 1;
        controller.enqueue(next);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

async function translate(events: ServerSentEvent[]) {
  return consume(translateStream(source(events).stream));
}

const text = (fragment: string): StreamEvent => ({ type: "text_delta", text: fragment });

function completion(events: StreamEvent[]) {
  const last = events.at(-1);
  if (last?.type !== "response_completed") {
    throw new Error(`expected a completion last, got ${JSON.stringify(last)}`);
  }
  return last;
}

describe("translateStream: text", () => {
  it("delivers each text fragment in order, and they rebuild the full text", async () => {
    const { events, error } = await translate(textAnswer("The ", "answer ", "is 4."));

    expect(error).toBeUndefined();
    expect(events.slice(0, -1)).toEqual([text("The "), text("answer "), text("is 4.")]);
    const joined = events.flatMap((event) => (event.type === "text_delta" ? [event.text] : []));
    expect(joined.join("")).toBe("The answer is 4.");
  });

  it("emits nothing for an empty text delta", async () => {
    const { events } = await translate(textAnswer("Hi", "", " there"));

    expect(events.slice(0, -1)).toEqual([text("Hi"), text(" there")]);
  });
});

describe("translateStream: tool calls", () => {
  const toolAnswer = (...fragments: string[]): ServerSentEvent[] => [
    messageStart(),
    toolStart(0, "toolu_1", "read_file"),
    ...fragments.map((fragment) => jsonDelta(0, fragment)),
    blockStop(0),
    messageDelta("tool_use"),
    messageStop(),
  ];

  it("announces the call at its start and delivers it, parsed, at its end", async () => {
    const { events, error } = await translate(toolAnswer('{"pa', 'th": "a', '.ts"}'));

    expect(error).toBeUndefined();
    expect(events.slice(0, -1)).toEqual([
      { type: "tool_call_started", id: "toolu_1", toolName: "read_file" },
      {
        type: "tool_call_completed",
        call: { type: "tool_call", id: "toolu_1", toolName: "read_file", input: { path: "a.ts" } },
      },
    ]);
  });

  it("parses an empty input as {}", async () => {
    const { events } = await translate(toolAnswer("", ""));

    expect(events[1]).toMatchObject({ type: "tool_call_completed", call: { input: {} } });
  });

  it("fails with protocol when the input isn't valid JSON, without completing the call", async () => {
    const { events, error } = await translate(toolAnswer('{"path": "a.ts"'));

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "protocol" });
    expect(events.map((event) => event.type)).toEqual(["tool_call_started"]);
  });

  it.each([["[1, 2]"], ['"a string"'], ["null"], ["42"]])(
    "fails with protocol when the input is valid JSON but not an object: %s",
    async (input) => {
      const { error } = await translate(toolAnswer(input));

      expect(error).toMatchObject({ kind: "protocol" });
    },
  );

  it("fails with protocol when the response ends with a tool call still open", async () => {
    const { error } = await translate([
      messageStart(),
      toolStart(0, "toolu_1", "read_file"),
      jsonDelta(0, "{}"),
      messageDelta("tool_use"),
      messageStop(),
    ]);

    expect(error).toMatchObject({ kind: "protocol" });
  });
});

describe("translateStream: unsupported blocks", () => {
  it("skips a thinking block and its deltas, and counts it", async () => {
    const { events, error } = await translate([
      messageStart(),
      blockStart(0, { type: "thinking", thinking: "", signature: "" }),
      delta(0, { type: "thinking_delta", thinking: "Let me think" }),
      delta(0, { type: "signature_delta", signature: "abc" }),
      blockStop(0),
      toolStart(1, "toolu_1", "read_file"),
      jsonDelta(1, '{"path": "a.ts"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ]);

    expect(error).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual([
      "tool_call_started",
      "tool_call_completed",
      "response_completed",
    ]);
    expect(completion(events).skippedBlocks).toBe(1);
  });

  it("skips known delta types too when their block is unsupported", async () => {
    const { events, error } = await translate([
      messageStart(),
      blockStart(0, { type: "server_tool_use", id: "srvtoolu_1", name: "web_search" }),
      jsonDelta(0, '{"query": "torno"}'),
      blockStop(0),
      textStart(1),
      textDelta(1, "Found it."),
      blockStop(1),
      messageDelta("end_turn"),
      messageStop(),
    ]);

    expect(error).toBeUndefined();
    expect(events.slice(0, -1)).toEqual([text("Found it.")]);
    expect(completion(events).skippedBlocks).toBe(1);
  });

  it("ignores unknown deltas on a text block", async () => {
    const { events, error } = await translate([
      messageStart(),
      textStart(0),
      textDelta(0, "Hi"),
      delta(0, { type: "citations_delta", citation: {} }),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]);

    expect(error).toBeUndefined();
    expect(events.slice(0, -1)).toEqual([text("Hi")]);
  });
});

describe("translateStream: completion", () => {
  it.each([
    ["end_turn", "end_turn"],
    ["tool_use", "tool_use"],
    ["max_tokens", "max_tokens"],
    ["stop_sequence", "other"],
    ["refusal", "other"],
    ["pause_turn", "other"],
  ])("maps the stop reason %s to %s", async (wire, expected) => {
    const events = [...textAnswer("Hi")];
    events[4] = messageDelta(wire);

    const { events: out } = await translate(events);

    expect(completion(out).stopReason).toBe(expected);
  });

  it("reports input, output and cache counts", async () => {
    const events = textAnswer("Hi");
    events[0] = messageStart({
      input_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1000,
    });
    events[4] = messageDelta("end_turn", { output_tokens: 20 });

    const { events: out } = await translate(events);

    expect(completion(out).usage).toStrictEqual({
      inputTokens: 50,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 1000,
    });
  });

  it("takes each count from the last event that reports it", async () => {
    const events = textAnswer("Hi");
    events[0] = messageStart({ input_tokens: 6, output_tokens: 0 });
    events[4] = messageDelta("end_turn", {
      input_tokens: 22,
      cache_read_input_tokens: 0,
      output_tokens: 6,
    });

    const { events: out } = await translate(events);

    expect(completion(out).usage).toStrictEqual({
      inputTokens: 22,
      outputTokens: 6,
      cacheReadTokens: 0,
    });
  });

  it("omits cache counts no event reports, including null ones", async () => {
    const events = textAnswer("Hi");
    events[0] = messageStart({ input_tokens: 10, cache_read_input_tokens: null });

    const { events: out } = await translate(events);

    expect(completion(out).usage).toStrictEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("reads nothing after message_stop, and releases its input", async () => {
    const events = [...textAnswer("Hi"), sse("content_block_delta", { surplus: true })];
    const { stream, state } = source(events);

    const { events: out, error } = await consume(translateStream(stream));

    expect(error).toBeUndefined();
    expect(out.at(-1)?.type).toBe("response_completed");
    expect(state.pulled).toBe(6);
    expect(state.cancelled).toBe(true);
  });

  it("fails with protocol when message_stop arrives without a message_start", async () => {
    const { error } = await translate(textAnswer("Hi").slice(1));

    expect(error).toMatchObject({ kind: "protocol" });
  });
});

describe("translateStream: events torno doesn't use", () => {
  it("ignores ping and unknown event types", async () => {
    const events = textAnswer("Hi", " there");
    events.splice(3, 0, sse("ping", { type: "ping" }), sse("future_event", { anything: 1 }));

    const { events: out, error } = await translate(events);

    expect(error).toBeUndefined();
    expect(out.slice(0, -1)).toEqual([text("Hi"), text(" there")]);
  });
});

describe("translateStream: invalid data", () => {
  it("fails with protocol when an event's data isn't JSON", async () => {
    const events = textAnswer("Hi");
    events[2] = { event: "content_block_delta", data: '{"type": "content_block_delta", "ind' };

    const { error } = await translate(events);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "protocol" });
  });

  it("fails with protocol when an event's data doesn't match its schema", async () => {
    const events = textAnswer("Hi");
    events[2] = delta(0, { type: "text_delta", text: 42 });

    const { error } = await translate(events);

    expect(error).toMatchObject({ kind: "protocol" });
  });

  it.each([
    ["text for a tool block", [toolStart(0, "toolu_1", "read_file"), textDelta(0, "Hi")]],
    ["tool input for a text block", [textStart(0), jsonDelta(0, "{}")]],
  ])("fails with protocol on a delta that doesn't fit its block: %s", async (_name, middle) => {
    const { error } = await translate([messageStart(), ...middle, blockStop(0), messageStop()]);

    expect(error).toMatchObject({ kind: "protocol" });
  });

  // Spec scenario "Block started twice". Replacing the open tool call would
  // lose it: "started" was already emitted, but "completed" never would be.
  it("fails with protocol when a block starts at an index that is still open", async () => {
    const { events, error } = await translate([
      messageStart(),
      toolStart(0, "toolu_1", "read_file"),
      textStart(0),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]);

    // Checked by message too: without that, the test could pass on some
    // other protocol error (it first did, on missing usage).
    expect(error).toMatchObject({ kind: "protocol" });
    expect((error as ProviderError).message).toContain("already open");
    expect(events.some((event) => event.type === "tool_call_completed")).toBe(false);
  });

  it("fails with protocol when a delta refers to a block that was never started", async () => {
    const events = textAnswer("Hi");
    events[2] = textDelta(7, "Hi");

    const { error } = await translate(events);

    expect(error).toMatchObject({ kind: "protocol" });
  });
});

describe("translateStream: failures", () => {
  it.each<[string, ProviderErrorKind]>([
    ["authentication_error", "auth"],
    ["permission_error", "auth"],
    ["billing_error", "auth"],
    ["rate_limit_error", "rate_limit"],
    ["overloaded_error", "overloaded"],
    ["api_error", "overloaded"],
    ["invalid_request_error", "invalid_request"],
    ["some_future_error", "invalid_request"],
  ])("maps an error event of type %s to the kind %s", async (type, kind) => {
    const events: ServerSentEvent[] = [
      messageStart(),
      textStart(0),
      textDelta(0, "Hel"),
      sse("error", { type: "error", error: { type, message: "Server says no" } }),
    ];

    const { events: out, error } = await translate(events);

    expect(out).toEqual([text("Hel")]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind });
    expect((error as Error).message).toContain("Server says no");
  });

  it("fails with network when the stream ends before message_stop", async () => {
    const { events, error } = await translate([messageStart(), textStart(0), textDelta(0, "Hel")]);

    expect(events).toEqual([text("Hel")]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "network" });
  });
});
