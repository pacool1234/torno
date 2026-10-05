import { describe, expect, it } from "vitest";
import {
  ProviderError,
  type ProviderRequest,
  type StreamEvent,
} from "../../../core/ports/model-provider.ts";
import { ScriptedProvider } from "./scripted-provider.ts";

function requestWith(signal: AbortSignal): ProviderRequest {
  return {
    model: "scripted",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    maxOutputTokens: 100,
    signal,
  };
}

const text = (fragment: string): StreamEvent => ({ type: "text_delta", text: fragment });

const completed: StreamEvent = {
  type: "response_completed",
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 2 },
  skippedBlocks: 0,
};

async function consume(
  stream: AsyncIterable<StreamEvent>,
): Promise<{ events: StreamEvent[]; error: unknown }> {
  const events: StreamEvent[] = [];
  try {
    for await (const event of stream) {
      events.push(event);
    }
    return { events, error: undefined };
  } catch (error: unknown) {
    return { events, error };
  }
}

describe("ScriptedProvider", () => {
  it("replays a script that ends normally", async () => {
    const provider = new ScriptedProvider([{ events: [text("Hi"), completed] }]);

    const { events, error } = await consume(
      provider.stream(requestWith(new AbortController().signal)),
    );

    expect(events).toEqual([text("Hi"), completed]);
    expect(error).toBeUndefined();
  });

  it("fails with the scripted kind after delivering the scripted events", async () => {
    const provider = new ScriptedProvider([
      { events: [text("Hi"), text(" there")], ending: { type: "fail", kind: "network" } },
    ]);

    const { events, error } = await consume(
      provider.stream(requestWith(new AbortController().signal)),
    );

    expect(events).toEqual([text("Hi"), text(" there")]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "network" });
  });

  it("waits until the signal fires, then fails with aborted", async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([{ events: [text("Hel")], ending: { type: "hang" } }]);

    const iterator = provider.stream(requestWith(controller.signal))[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: text("Hel") });

    const pending = iterator.next();
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(ProviderError);
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });

  it("fails with aborted before any event when the signal has already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new ScriptedProvider([{ events: [text("Hi"), completed] }]);

    const { events, error } = await consume(provider.stream(requestWith(controller.signal)));

    expect(events).toEqual([]);
    expect(error).toMatchObject({ kind: "aborted" });
  });

  it("releases its resources when the consumer stops early, without throwing", async () => {
    const provider = new ScriptedProvider([{ events: [text("Hi"), text(" there"), completed] }]);

    const received: StreamEvent[] = [];
    for await (const event of provider.stream(requestWith(new AbortController().signal))) {
      received.push(event);
      break;
    }

    expect(received).toEqual([text("Hi")]);
    expect(provider.openStreams).toBe(0);
  });

  it("serves one script per call, in order, and records every request", async () => {
    const provider = new ScriptedProvider([
      { events: [text("first"), completed] },
      { events: [text("second"), completed] },
    ]);
    const request = requestWith(new AbortController().signal);

    const first = await consume(provider.stream(request));
    const second = await consume(provider.stream(request));

    expect(first.events[0]).toEqual(text("first"));
    expect(second.events[0]).toEqual(text("second"));
    expect(provider.requests).toEqual([request, request]);
  });

  it("fails loudly when a test makes more calls than it scripted", async () => {
    const provider = new ScriptedProvider([]);

    const { error } = await consume(provider.stream(requestWith(new AbortController().signal)));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProviderError);
  });
});
