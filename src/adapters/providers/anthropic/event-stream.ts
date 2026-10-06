export type ServerSentEvent = {
  event: string;
  data: string;
};

export async function* parseEventStream(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const decoder = new TextDecoder("utf-8");

  let pending = "";

  let eventType = "";
  let dataLines: string[] = [];

  function handleLine(line: string): ServerSentEvent | undefined {
    if (line === "") {
      const finished =
        dataLines.length > 0
          ? { event: eventType === "" ? "message" : eventType, data: dataLines.join("\n") }
          : undefined;
      eventType = "";
      dataLines = [];
      return finished;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      eventType = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
    return undefined;
  }

  function* drainCompleteLines(): Generator<ServerSentEvent> {
    let start = 0;
    let newline = pending.indexOf("\n", start);
    while (newline !== -1) {
      let line = pending.slice(start, newline);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      const event = handleLine(line);
      if (event !== undefined) {
        yield event;
      }
      start = newline + 1;
      newline = pending.indexOf("\n", start);
    }
    pending = pending.slice(start);
  }

  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    yield* drainCompleteLines();
  }

  pending += decoder.decode();
  yield* drainCompleteLines();
}
