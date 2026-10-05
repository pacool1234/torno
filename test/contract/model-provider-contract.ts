import { describe, expect, it } from "vitest";
import {
  type ModelProvider,
  ProviderError,
  type ProviderRequest,
  type StreamEvent,
} from "../../src/core/ports/model-provider.ts";

export type ContractSituation =
  "text_only" | "text_then_tool_call" | "failure_after_text" | "never_finishes";

export type ContractSubject = {
  provider: ModelProvider;
  openResources: () => number;
};

export type ContractFactory = (situation: ContractSituation) => ContractSubject;

function requestWith(signal: AbortSignal): ProviderRequest {
  return {
    model: "contract-test",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    maxOutputTokens: 100,
    signal,
  };
}

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

async function run(subject: ContractSubject): Promise<{ events: StreamEvent[]; error: unknown }> {
  return consume(subject.provider.stream(requestWith(new AbortController().signal)));
}

function expectCompletedLast(
  events: StreamEvent[],
): Extract<StreamEvent, { type: "response_completed" }> {
  const completions = events.filter((event) => event.type === "response_completed");
  expect(completions).toHaveLength(1);

  const last = events.at(-1);

  expect(last?.type).toBe("response_completed");
  if (last?.type !== "response_completed") {
    throw new Error("unreachable: last event is not a completion");
  }
  return last;
}

function expectNonNegativeInteger(value: unknown): void {
  expect(Number.isInteger(value)).toBe(true);
  expect(value as number).toBeGreaterThanOrEqual(0);
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function describeModelProviderContract(name: string, factory: ContractFactory): void {
  describe(`ModelProvider contract: ${name}`, () => {
    describe("a text-only answer", () => {
      it("accepts a request without tools and streams the response to completion", async () => {
        const subject = factory("text_only");

        const { events, error } = await run(subject);

        expect(error).toBeUndefined();
        expect(events.length).toBeGreaterThan(0);
        expect(subject.openResources()).toBe(0);
      });

      it("delivers only non-empty text fragments, then exactly one completion, last", async () => {
        const { events } = await run(factory("text_only"));

        expectCompletedLast(events);
        const beforeCompletion = events.slice(0, -1);
        expect(beforeCompletion.length).toBeGreaterThan(0);
        for (const event of beforeCompletion) {
          expect(event.type).toBe("text_delta");
          if (event.type === "text_delta") {
            expect(event.text).not.toBe("");
          }
        }
      });

      it("completes with end_turn and reports token usage", async () => {
        const { events } = await run(factory("text_only"));

        const completion = expectCompletedLast(events);
        expect(completion.stopReason).toBe("end_turn");
        expectNonNegativeInteger(completion.usage.inputTokens);
        expectNonNegativeInteger(completion.usage.outputTokens);
        expectNonNegativeInteger(completion.skippedBlocks);

        for (const cacheCount of [
          completion.usage.cacheReadTokens,
          completion.usage.cacheWriteTokens,
        ]) {
          if (cacheCount !== undefined) {
            expectNonNegativeInteger(cacheCount);
          }
        }
      });
    });

    describe("text, then a tool call", () => {
      it("announces each tool call, then delivers it once, complete, with parsed input", async () => {
        const { events, error } = await run(factory("text_then_tool_call"));

        expect(error).toBeUndefined();
        const started = events.flatMap((event, index) =>
          event.type === "tool_call_started" ? [{ event, index }] : [],
        );
        expect(started.length).toBeGreaterThan(0);

        for (const { event: start, index: startIndex } of started) {
          const completions = events.flatMap((event, index) =>
            event.type === "tool_call_completed" && event.call.id === start.id
              ? [{ event, index }]
              : [],
          );
          expect(completions).toHaveLength(1);
          const [completion] = completions;
          expect(completion?.index).toBeGreaterThan(startIndex);
          expect(completion?.event.call.toolName).toBe(start.toolName);
          expect(isPlainObject(completion?.event.call.input)).toBe(true);
        }
      });

      it("delivers the text before the tool call starts", async () => {
        const { events } = await run(factory("text_then_tool_call"));

        const lastText = events.findLastIndex((event) => event.type === "text_delta");
        const firstToolCall = events.findIndex((event) => event.type === "tool_call_started");
        expect(lastText).toBeGreaterThanOrEqual(0);
        expect(lastText).toBeLessThan(firstToolCall);
      });

      it("completes with tool_use, and nothing follows the completion", async () => {
        const subject = factory("text_then_tool_call");

        const { events } = await run(subject);

        expect(expectCompletedLast(events).stopReason).toBe("tool_use");
        expect(subject.openResources()).toBe(0);
      });
    });

    describe("a failure after some text", () => {
      it("keeps the text already delivered, then throws a network ProviderError, never completing", async () => {
        const subject = factory("failure_after_text");

        const { events, error } = await run(subject);

        expect(events.length).toBeGreaterThan(0);
        expect(events.every((event) => event.type === "text_delta")).toBe(true);
        expect(error).toBeInstanceOf(ProviderError);
        expect(error).toMatchObject({ kind: "network" });
        expect(subject.openResources()).toBe(0);
      });
    });

    describe("cancellation", () => {
      it("cancelled before starting: stream() itself doesn't throw, and iteration throws aborted before any event", async () => {
        const subject = factory("text_only");
        const controller = new AbortController();
        controller.abort();

        const stream = subject.provider.stream(requestWith(controller.signal));
        const { events, error } = await consume(stream);

        expect(events).toEqual([]);
        expect(error).toBeInstanceOf(ProviderError);
        expect(error).toMatchObject({ kind: "aborted" });
        expect(subject.openResources()).toBe(0);
      });

      it("cancelled mid-response: no further events, then aborted", async () => {
        const subject = factory("never_finishes");
        const controller = new AbortController();

        const events: StreamEvent[] = [];
        let error: unknown;
        try {
          for await (const event of subject.provider.stream(requestWith(controller.signal))) {
            events.push(event);
            controller.abort();
          }
        } catch (caught: unknown) {
          error = caught;
        }

        expect(events).toHaveLength(1);
        expect(error).toBeInstanceOf(ProviderError);
        expect(error).toMatchObject({ kind: "aborted" });
        expect(subject.openResources()).toBe(0);
      });
    });

    describe("a consumer that stops early", () => {
      it("releases its resources without throwing when the consumer breaks after the first event", async () => {
        const subject = factory("text_only");

        for await (const event of subject.provider.stream(
          requestWith(new AbortController().signal),
        )) {
          expect(event.type).toBe("text_delta");
          break;
        }

        expect(subject.openResources()).toBe(0);
      });
    });
  });
}
