import { z } from "zod";
import {
  type ModelProvider,
  ProviderError,
  type ProviderRequest,
  type StreamEvent,
} from "../../../core/ports/model-provider.ts";
import { kindForStatus } from "./errors.ts";
import { parseEventStream } from "./event-stream.ts";
import { anthropicHeaders, messagesUrl, toAnthropicBody } from "./request.ts";
import { translateStream } from "./translate.ts";

export type AnthropicProviderOptions = {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  idleTimeoutMs?: number;
};

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

const MAX_ERROR_DETAIL = 300;

const errorBodySchema = z.object({
  error: z.object({ type: z.string(), message: z.string() }),
});

export class AnthropicProvider implements ModelProvider {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;
  readonly #idleTimeoutMs: number;

  constructor(options: AnthropicProviderOptions) {
    this.#url = messagesUrl(options.baseUrl);
    this.#headers = anthropicHeaders(options.apiKey);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  stream(request: ProviderRequest): AsyncIterable<StreamEvent> {
    return this.#run(request);
  }

  async *#run(request: ProviderRequest): AsyncGenerator<StreamEvent> {
    const idle = new IdleTimer(this.#idleTimeoutMs);
    const signal = AbortSignal.any([request.signal, idle.signal]);
    let step: "connect" | "read" = "connect";

    try {
      idle.start();
      const response = await this.#fetch(this.#url, {
        method: "POST",
        headers: this.#headers,
        body: JSON.stringify(toAnthropicBody(request)),
        signal,
      });
      idle.stop();
      step = "read";

      if (!response.ok) {
        idle.start();
        throw await httpError(response);
      }
      const contentType = response.headers.get("content-type");
      if (!isEventStream(contentType)) {
        // The body won't be read, so release the connection now rather than
        // leaving it to garbage collection.
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderError(
          "protocol",
          `Expected an event stream, but the server sent ${contentType ?? "no content type"}. Is the base URL right?`,
        );
      }
      if (response.body === null) {
        throw new ProviderError("protocol", `HTTP ${response.status} response has no body`);
      }

      yield* translateStream(parseEventStream(watchIdle(response.body, idle)));
    } catch (error: unknown) {
      throw classify(error, { request, idle, step, url: this.#url });
    } finally {
      idle.stop();
    }
  }
}

// A 200 that isn't an event stream means the base URL points at some other
// server (a web app's catch-all page, say). Reading it as events would find
// none and fail as `network`, which callers retry; a wrong server is a setup
// problem, so it fails as `protocol` here instead. Only the media type is
// compared: Anthropic adds "; charset=utf-8", and media types are
// case-insensitive (RFC 9110).
function isEventStream(contentType: string | null): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
}

class IdleTimer {
  readonly #ms: number;
  readonly #controller = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(ms: number) {
    this.#ms = ms;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get timedOut(): boolean {
    return this.#controller.signal.aborted;
  }

  get seconds(): number {
    return this.#ms / 1000;
  }

  start(): void {
    this.stop();
    this.#timer = setTimeout(() => {
      this.#controller.abort(new DOMException("Idle timeout", "TimeoutError"));
    }, this.#ms);
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}

async function* watchIdle(
  body: ReadableStream<Uint8Array>,
  idle: IdleTimer,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      idle.start();
      const { done, value } = await reader.read();
      idle.stop();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function classify(
  error: unknown,
  context: { request: ProviderRequest; idle: IdleTimer; step: "connect" | "read"; url: string },
): ProviderError {
  const { request, idle, step, url } = context;
  if (idle.timedOut) {
    return new ProviderError("timeout", `No data from the server for ${idle.seconds} seconds`, {
      cause: error,
    });
  }
  if (request.signal.aborted) {
    return new ProviderError("aborted", "The request was cancelled", {
      cause: request.signal.reason,
    });
  }
  if (error instanceof ProviderError) {
    return error;
  }
  return new ProviderError(
    "network",
    step === "connect"
      ? `Could not reach ${url}`
      : "The connection failed while reading the response",
    { cause: error },
  );
}

async function httpError(response: Response): Promise<ProviderError> {
  let detail: string;
  try {
    const text = await response.text();
    detail = describeErrorBody(text);
  } catch {
    detail = "(the error body could not be read)";
  }
  return new ProviderError(kindForStatus(response.status), `HTTP ${response.status}: ${detail}`);
}

function describeErrorBody(text: string): string {
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      return `${parsed.data.error.type}: ${parsed.data.error.message}`;
    }
  } catch {
    // Not JSON (e.g. a proxy's HTML page): use the raw text below.
  }
  return text.length > MAX_ERROR_DETAIL ? `${text.slice(0, MAX_ERROR_DETAIL)}…` : text;
}
