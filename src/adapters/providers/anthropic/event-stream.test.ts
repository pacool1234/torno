import { describe, expect, it } from "vitest";
import { parseEventStream, type ServerSentEvent } from "./event-stream.ts";

const encoder = new TextEncoder();

function chunksOf(...parts: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(typeof part === "string" ? encoder.encode(part) : part);
      }
      controller.close();
    },
  });
}

async function parse(...parts: (string | Uint8Array)[]): Promise<ServerSentEvent[]> {
  const events: ServerSentEvent[] = [];
  for await (const event of parseEventStream(chunksOf(...parts))) {
    events.push(event);
  }
  return events;
}

function splitBytes(text: string, offsets: number[]): Uint8Array[] {
  const bytes = encoder.encode(text);
  const cuts = [0, ...offsets, bytes.length];
  return cuts.slice(1).map((end, i) => bytes.slice(cuts[i], end));
}

describe("parseEventStream", () => {
  it("reads one event's type and data", async () => {
    expect(await parse('event: ping\ndata: {"type":"ping"}\n\n')).toEqual([
      { event: "ping", data: '{"type":"ping"}' },
    ]);
  });

  it("reads several events in order", async () => {
    expect(await parse("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n")).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("joins several data lines with a line break", async () => {
    expect(await parse("event: a\ndata: first\ndata: second\n\n")).toEqual([
      { event: "a", data: "first\nsecond" },
    ]);
  });

  it("ignores comment lines and fields it doesn't use", async () => {
    expect(await parse(": keep-alive\nid: 7\nretry: 1000\nevent: a\ndata: 1\n\n")).toEqual([
      { event: "a", data: "1" },
    ]);
  });

  it("removes exactly one space after the colon, and accepts none", async () => {
    expect(await parse("event:a\ndata:  two spaces\n\n")).toEqual([
      { event: "a", data: " two spaces" },
    ]);
  });

  it("accepts CRLF line endings", async () => {
    expect(await parse("event: a\r\ndata: 1\r\n\r\n")).toEqual([{ event: "a", data: "1" }]);
  });

  it('uses the type "message" when an event has no event field', async () => {
    expect(await parse("data: 1\n\n")).toEqual([{ event: "message", data: "1" }]);
  });

  it("doesn't emit an event that has no data", async () => {
    expect(await parse("event: a\n\ndata: 1\n\n")).toEqual([{ event: "message", data: "1" }]);
  });

  it("drops an event the body ends in the middle of", async () => {
    expect(await parse("event: a\ndata: 1\n\nevent: b\ndata: 2")).toEqual([
      { event: "a", data: "1" },
    ]);
  });

  it("emits nothing for an empty body", async () => {
    expect(await parse()).toEqual([]);
  });

  describe("chunk boundaries", () => {
    const body =
      'event: content_block_delta\ndata: {"text":"héllo ✓ 🎉"}\n\n' +
      ": comment\r\nevent: message_stop\r\ndata: {}\r\n\r\n";

    it("gives the same events whatever the split", async () => {
      const expected = await parse(body);
      expect(expected).toHaveLength(2);
      expect(expected[0]?.data).toBe('{"text":"héllo ✓ 🎉"}');

      const length = encoder.encode(body).length;
      const everyByte = Array.from({ length: length - 1 }, (_, i) => i + 1);
      expect(await parse(...splitBytes(body, everyByte))).toEqual(expected);

      for (let offset = 1; offset < length; offset += 1) {
        expect(await parse(...splitBytes(body, [offset]))).toEqual(expected);
      }
    });
  });
});
