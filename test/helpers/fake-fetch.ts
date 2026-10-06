export type FakeResponse = {
  status?: number;
  chunks?: (string | Uint8Array)[];
  end?: "close" | "error" | "hang";
  connectionError?: boolean;
  noResponse?: boolean;
  chunkDelayMs?: number;
  // The response's content-type; null sends none. Defaults to an event stream.
  contentType?: string | null;
};

export type RecordedCall = {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
};

export type FakeFetch = {
  fetch: typeof fetch;
  calls: RecordedCall[];
  openBodies: () => number;
};

export function fakeFetch(...responses: FakeResponse[]): FakeFetch {
  const calls: RecordedCall[] = [];
  let open = 0;
  const encoder = new TextEncoder();

  const respond = (input: string | URL | Request, init?: RequestInit): Response | undefined => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });

    const answer = responses[calls.length - 1];
    if (answer === undefined) {
      throw new Error(`fakeFetch: call #${calls.length} has no scripted response`);
    }

    const signal = init?.signal ?? undefined;
    if (signal?.aborted) {
      throw signal.reason;
    }
    if (answer.connectionError === true) {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    }
    if (answer.noResponse === true) {
      return undefined;
    }

    const chunks = (answer.chunks ?? []).map((chunk) =>
      typeof chunk === "string" ? encoder.encode(chunk) : chunk,
    );
    const end = answer.end ?? "close";

    let finished = false;
    let onAbort: (() => void) | undefined;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      open -= 1;
      if (onAbort !== undefined) {
        signal?.removeEventListener("abort", onAbort);
      }
    };

    open += 1;
    let next = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          if (signal !== undefined) {
            onAbort = () => {
              finish();
              controller.error(signal.reason);
            };
            signal.addEventListener("abort", onAbort, { once: true });
          }
        },
        async pull(controller) {
          if (answer.chunkDelayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, answer.chunkDelayMs));
            if (finished) {
              return;
            }
          }
          const chunk = chunks[next];
          if (chunk !== undefined) {
            next += 1;
            controller.enqueue(chunk);
            return;
          }
          if (end === "close") {
            finish();
            controller.close();
          } else if (end === "error") {
            finish();
            controller.error(new TypeError("terminated", { cause: new Error("socket closed") }));
          }
        },
        cancel() {
          finish();
        },
      },
      { highWaterMark: 0 },
    );

    return new Response(body, {
      status: answer.status ?? 200,
      headers:
        answer.contentType === null
          ? {}
          : { "content-type": answer.contentType ?? "text/event-stream" },
    });
  };

  const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const response = respond(input, init);
      if (response !== undefined) {
        resolve(response);
        return;
      }
      const signal = init?.signal;
      signal?.addEventListener(
        "abort",
        () => {
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("This operation was aborted", "AbortError"),
          );
        },
        { once: true },
      );
    });

  return { fetch: fake, calls, openBodies: () => open };
}
