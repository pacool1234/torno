import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderError,
  type ProviderErrorKind,
  type ProviderRequest,
} from "../../../core/ports/model-provider.ts";
import { consume } from "../../../../test/helpers/consume.ts";
import { type FakeResponse, fakeFetch } from "../../../../test/helpers/fake-fetch.ts";
import { AnthropicProvider } from "./anthropic-provider.ts";

const API_KEY = "sk-ant-test-0000000000";

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "claude-haiku-4-5",
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    tools: [],
    maxOutputTokens: 100,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function providerFor(...responses: FakeResponse[]) {
  const fake = fakeFetch(...responses);
  const provider = new AnthropicProvider({
    baseUrl: "https://api.anthropic.com",
    apiKey: API_KEY,
    fetch: fake.fetch,
  });
  return { provider, fake };
}

const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const okBody = [
  event("message_start", { type: "message_start", message: { usage: { input_tokens: 10 } } }),
  event("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  event("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello" },
  }),
  event("content_block_stop", { type: "content_block_stop", index: 0 }),
  event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 1 },
  }),
  event("message_stop", { type: "message_stop" }),
];

describe("AnthropicProvider: the request", () => {
  it("POSTs the mapped body to /v1/messages with the protocol headers", async () => {
    const { provider, fake } = providerFor({ chunks: okBody });

    await consume(provider.stream(request()));

    expect(fake.calls).toEqual([
      {
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": API_KEY,
        },
        body: {
          model: "claude-haiku-4-5",
          max_tokens: 100,
          stream: true,
          messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        },
      },
    ]);
  });

  it("sends nothing until the stream is iterated", () => {
    const { provider, fake } = providerFor({ chunks: okBody });

    provider.stream(request());

    expect(fake.calls).toHaveLength(0);
  });
});

describe("AnthropicProvider: a successful response", () => {
  it("streams the translated events", async () => {
    const { provider } = providerFor({ chunks: okBody });

    const { events, error } = await consume(provider.stream(request()));

    expect(error).toBeUndefined();
    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      {
        type: "response_completed",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 1 },
        skippedBlocks: 0,
      },
    ]);
  });
});

// Spec scenario "Not an event stream". A 200 that isn't a stream means the
// base URL points at the wrong server; without this check the parser finds no
// events and the failure surfaces as a retryable `network` error.
describe("AnthropicProvider: a response that isn't an event stream", () => {
  it.each([
    ["text/html; charset=utf-8", "text/html"],
    ["application/json", "application/json"],
    [null, "no content type"],
  ])(
    "fails with protocol for content-type %j, naming it, before any event",
    async (contentType, named) => {
      const { provider, fake } = providerFor({
        contentType,
        chunks: ["<!doctype html><html><body>Vite dev server</body></html>"],
      });

      const { events, error } = await consume(provider.stream(request()));

      expect(events).toEqual([]);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ kind: "protocol" });
      expect((error as ProviderError).message).toContain(named);
      // The body is never read, so it must be cancelled explicitly.
      expect(fake.openBodies()).toBe(0);
    },
  );

  // Anthropic sends "text/event-stream; charset=utf-8": parameters after the
  // media type, and its case, must not matter.
  it.each(["text/event-stream; charset=utf-8", "Text/Event-Stream"])(
    "accepts %j",
    async (contentType) => {
      const { provider } = providerFor({ contentType, chunks: okBody });

      const { error } = await consume(provider.stream(request()));

      expect(error).toBeUndefined();
    },
  );
});

describe("AnthropicProvider: HTTP errors", () => {
  const errorBody = (type: string, message: string) =>
    JSON.stringify({ type: "error", error: { type, message }, request_id: "req_1" });

  it.each<[number, ProviderErrorKind]>([
    [401, "auth"],
    [402, "auth"],
    [403, "auth"],
    [429, "rate_limit"],
    [500, "overloaded"],
    [502, "overloaded"],
    [503, "overloaded"],
    [504, "overloaded"],
    [529, "overloaded"],
    [400, "invalid_request"],
    [404, "invalid_request"],
    [413, "invalid_request"],
    [418, "invalid_request"],
  ])("maps HTTP %i to %s, before any event", async (status, kind) => {
    const { provider } = providerFor({
      status,
      chunks: [errorBody("some_error", "Server explains the problem")],
    });

    const { events, error } = await consume(provider.stream(request()));

    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind });
  });

  it("includes the status and the server's message, never the API key", async () => {
    const { provider } = providerFor({
      status: 401,
      chunks: [errorBody("authentication_error", "invalid x-api-key")],
    });

    const { events, error } = await consume(provider.stream(request()));

    expect(events).toEqual([]);
    expect(error).toMatchObject({ kind: "auth" });
    const message = (error as Error).message;
    expect(message).toContain("401");
    expect(message).toContain("invalid x-api-key");
    expect(message).not.toContain(API_KEY);
  });

  it("keeps the start of a body that isn't JSON, such as a proxy's HTML page", async () => {
    const { provider } = providerFor({
      status: 502,
      chunks: [`<html><body>Bad Gateway</body></html>${"x".repeat(5000)}`],
    });

    const { error } = await consume(provider.stream(request()));

    expect(error).toMatchObject({ kind: "overloaded" });
    const message = (error as Error).message;
    expect(message).toContain("Bad Gateway");
    expect(message.length).toBeLessThan(600);
  });
});

describe("AnthropicProvider: network failures", () => {
  it("fails with network when the connection can't be made", async () => {
    const { provider } = providerFor({ connectionError: true });

    const { events, error } = await consume(provider.stream(request()));

    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "network" });
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });

  it("fails with network when reading the body fails mid-stream, keeping earlier events", async () => {
    const { provider } = providerFor({ chunks: okBody.slice(0, 3), end: "error" });

    const { events, error } = await consume(provider.stream(request()));

    expect(events).toEqual([{ type: "text_delta", text: "Hello" }]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "network" });
  });
});

function providerWithTimeout(idleTimeoutMs: number, ...responses: FakeResponse[]) {
  const fake = fakeFetch(...responses);
  const provider = new AnthropicProvider({
    baseUrl: "https://api.anthropic.com",
    fetch: fake.fetch,
    idleTimeoutMs,
  });
  return { provider, fake };
}

function track<T>(promise: Promise<T>): { settled: boolean } {
  const state = { settled: false };
  void promise.finally(() => {
    state.settled = true;
  });
  return state;
}

describe("AnthropicProvider: cancellation", () => {
  it("fails with aborted before any event when the signal has already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, fake } = providerFor({ chunks: okBody });

    const { events, error } = await consume(
      provider.stream(request({ signal: controller.signal })),
    );

    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "aborted" });
    expect(fake.openBodies()).toBe(0);
  });

  it("fails with aborted when cancelled while waiting for the response", async () => {
    const controller = new AbortController();
    const { provider } = providerFor({ noResponse: true });

    const result = consume(provider.stream(request({ signal: controller.signal })));
    controller.abort();
    const { events, error } = await result;

    expect(events).toEqual([]);
    expect(error).toMatchObject({ kind: "aborted" });
  });

  it("stops mid-stream with aborted, delivering nothing more", async () => {
    const controller = new AbortController();
    const { provider, fake } = providerFor({ chunks: okBody.slice(0, 3), end: "hang" });

    const events: unknown[] = [];
    let error: unknown;
    try {
      for await (const event of provider.stream(request({ signal: controller.signal }))) {
        events.push(event);
        controller.abort();
      }
    } catch (caught: unknown) {
      error = caught;
    }

    expect(events).toEqual([{ type: "text_delta", text: "Hello" }]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "aborted" });
    expect(fake.openBodies()).toBe(0);
  });
});

describe("AnthropicProvider: idle timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails with timeout when the response doesn't arrive in time", async () => {
    const { provider } = providerWithTimeout(1000, { noResponse: true });

    const result = consume(provider.stream(request()));
    const state = track(result);
    await vi.advanceTimersByTimeAsync(999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const { events, error } = await result;

    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "timeout" });
  });

  it("fails with timeout when the body stalls, keeping the events already delivered", async () => {
    const { provider, fake } = providerWithTimeout(1000, {
      chunks: okBody.slice(0, 3),
      end: "hang",
    });

    const result = consume(provider.stream(request()));
    const state = track(result);
    await vi.advanceTimersByTimeAsync(999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const { events, error } = await result;

    expect(events).toEqual([{ type: "text_delta", text: "Hello" }]);
    expect(error).toMatchObject({ kind: "timeout" });
    expect(fake.openBodies()).toBe(0);
  });

  it("lets a slow stream finish as long as each chunk arrives in time", async () => {
    const { provider } = providerWithTimeout(1000, { chunks: okBody, chunkDelayMs: 600 });

    const result = consume(provider.stream(request()));
    await vi.advanceTimersByTimeAsync(4000);
    const { events, error } = await result;

    expect(error).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "response_completed" });
  });

  it("doesn't count the time the consumer spends handling an event", async () => {
    const { provider } = providerWithTimeout(1000, { chunks: okBody });

    const events: unknown[] = [];
    for await (const event of provider.stream(request())) {
      events.push(event);
      await vi.advanceTimersByTimeAsync(5000);
    }

    expect(events.at(-1)).toMatchObject({ type: "response_completed" });
  });

  it("waits 60 seconds by default", async () => {
    const { provider } = providerFor({ noResponse: true });

    const result = consume(provider.stream(request()));
    const state = track(result);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect((await result).error).toMatchObject({ kind: "timeout" });
  });
});

describe("AnthropicProvider: releasing resources", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<
    [
      string,
      () => { response: FakeResponse; run: (stream: AsyncIterable<unknown>) => Promise<unknown> },
    ]
  >([
    ["completion", () => ({ response: { chunks: okBody }, run: consume })],
    ["an HTTP error", () => ({ response: { status: 500, chunks: ["oops"] }, run: consume })],
    [
      "a protocol error mid-body",
      () => ({
        response: { chunks: [...okBody.slice(0, 3), "event: message_delta\ndata: {not json\n\n"] },
        run: consume,
      }),
    ],
    [
      "a broken body",
      () => ({ response: { chunks: okBody.slice(0, 3), end: "error" }, run: consume }),
    ],
    [
      "the consumer stopping after the first event",
      () => ({
        response: { chunks: okBody },
        run: async (stream) => {
          for await (const event of stream) {
            void event;
            break;
          }
        },
      }),
    ],
  ])("after %s, no body is open and no timer is running", async (_ending, setup) => {
    const { response, run } = setup();
    const { provider, fake } = providerWithTimeout(1000, response);

    await run(provider.stream(request()));

    expect(fake.openBodies()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("after a timeout, no body is open and no timer is running", async () => {
    const { provider, fake } = providerWithTimeout(1000, {
      chunks: okBody.slice(0, 3),
      end: "hang",
    });

    const result = consume(provider.stream(request()));
    await vi.advanceTimersByTimeAsync(1000);
    await result;

    expect(fake.openBodies()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("after a cancellation, no body is open and no timer is running", async () => {
    const controller = new AbortController();
    const { provider, fake } = providerWithTimeout(1000, {
      chunks: okBody.slice(0, 3),
      end: "hang",
    });

    for await (const event of provider.stream(request({ signal: controller.signal }))) {
      void event;
      controller.abort();
      break;
    }

    expect(fake.openBodies()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
