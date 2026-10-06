import { describe, expect, it } from "vitest";
import { ProviderError, type StreamEvent } from "../../../core/ports/model-provider.ts";
import { consume } from "../../../../test/helpers/consume.ts";
import { fakeFetch } from "../../../../test/helpers/fake-fetch.ts";
import {
  FIXTURE_NAMES,
  type FixtureName,
  chunked,
  loadFixture,
  recordedText,
} from "../../../../test/helpers/fixtures.ts";
import { AnthropicProvider } from "./anthropic-provider.ts";

async function replay(name: FixtureName, chunkSize?: number) {
  const fixture = loadFixture(name);
  const fake = fakeFetch({
    status: fixture.status,
    chunks: chunkSize === undefined ? [fixture.body] : chunked(fixture.body, chunkSize),
  });
  const provider = new AnthropicProvider({ baseUrl: "https://api.test", fetch: fake.fetch });
  const result = await consume(
    provider.stream({
      model: "replay",
      messages: [{ role: "user", content: [{ type: "text", text: "replay" }] }],
      tools: [],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    }),
  );
  return { ...result, openBodies: fake.openBodies() };
}

const textOf = (events: StreamEvent[]) =>
  events.flatMap((event) => (event.type === "text_delta" ? [event.text] : [])).join("");

function completionOf(events: StreamEvent[]) {
  const last = events.at(-1);
  if (last?.type !== "response_completed") {
    throw new Error(`expected a completion last, got ${last?.type ?? "no events"}`);
  }
  return last;
}

describe("AnthropicProvider: recorded responses", () => {
  describe.each(FIXTURE_NAMES)("%s", (name) => {
    it.each([1, 7, 64])(
      "gives the same events in chunks of %i bytes as in one piece",
      async (size) => {
        const whole = await replay(name);
        const pieces = await replay(name, size);

        expect(pieces.events).toEqual(whole.events);
        expect(pieces.error).toEqual(whole.error);
        expect(pieces.openBodies).toBe(0);
      },
    );
  });

  it.each(["haiku-text", "haiku-tool-call", "haiku-max-tokens"] as const)(
    "%s: the text fragments rebuild the recorded text",
    async (name) => {
      const { events } = await replay(name, 1);

      const expected = recordedText(loadFixture(name).body);
      expect(expected).not.toBe("");
      expect(textOf(events)).toBe(expected);
    },
  );

  it("haiku-text: completes with end_turn and non-ASCII text intact", async () => {
    const { events, error } = await replay("haiku-text", 1);

    expect(error).toBeUndefined();
    expect(completionOf(events).stopReason).toBe("end_turn");
    expect(textOf(events)).toMatch(/[぀-ヿ一-鿿]/u);
  });

  it("haiku-tool-call: text, then a read_file call with parsed input, then tool_use", async () => {
    const { events, error } = await replay("haiku-tool-call");

    expect(error).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual([
      ...events.filter((event) => event.type === "text_delta").map(() => "text_delta"),
      "tool_call_started",
      "tool_call_completed",
      "response_completed",
    ]);
    const completed = events.find((event) => event.type === "tool_call_completed");
    expect(completed?.call).toMatchObject({ toolName: "read_file", input: { path: "README.md" } });
    expect(completionOf(events).stopReason).toBe("tool_use");
  });

  it("haiku-max-tokens: completes with max_tokens, keeping the partial text", async () => {
    const { events, error } = await replay("haiku-max-tokens");

    expect(error).toBeUndefined();
    expect(completionOf(events).stopReason).toBe("max_tokens");
    expect(textOf(events)).not.toBe("");
  });

  it("ollama-thinking-tool-call: skips the thinking block, counts it, and delivers the call", async () => {
    const { events, error } = await replay("ollama-thinking-tool-call");

    expect(error).toBeUndefined();
    const completion = completionOf(events);
    expect(completion.skippedBlocks).toBe(1);
    expect(completion.stopReason).toBe("tool_use");
    expect(events.some((event) => event.type === "text_delta")).toBe(false);
    const completed = events.find((event) => event.type === "tool_call_completed");
    expect(completed?.call).toMatchObject({ toolName: "read_file", input: { path: "README.md" } });
  });

  it("haiku-401: throws auth before any event, with the server's explanation", async () => {
    const { events, error, openBodies } = await replay("haiku-401");

    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "auth" });
    expect((error as ProviderError).message).toContain("authentication_error");
    expect(openBodies).toBe(0);
  });
});
