import { describe, expect, it } from "vitest";
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
