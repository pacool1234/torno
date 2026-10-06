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
};

const MAX_ERROR_DETAIL = 300;

const errorBodySchema = z.object({
  error: z.object({ type: z.string(), message: z.string() }),
});

export class AnthropicProvider implements ModelProvider {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;

  constructor(options: AnthropicProviderOptions) {
    this.#url = messagesUrl(options.baseUrl);
    this.#headers = anthropicHeaders(options.apiKey);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  stream(request: ProviderRequest): AsyncIterable<StreamEvent> {
    return this.#run(request);
  }

  async *#run(request: ProviderRequest): AsyncGenerator<StreamEvent> {
    const response = await this.#send(request);

    if (!response.ok) {
      throw await httpError(response);
    }
    if (response.body === null) {
      throw new ProviderError("protocol", `HTTP ${response.status} response has no body`);
    }

    try {
      yield* translateStream(parseEventStream(response.body));
    } catch (error: unknown) {
      throw asProviderError(error);
    }
  }

  async #send(request: ProviderRequest): Promise<Response> {
    try {
      return await this.#fetch(this.#url, {
        method: "POST",
        headers: this.#headers,
        body: JSON.stringify(toAnthropicBody(request)),
        signal: request.signal,
      });
    } catch (cause: unknown) {
      throw new ProviderError("network", `Could not reach ${this.#url}`, { cause });
    }
  }
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

function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  return new ProviderError("network", "The connection failed while reading the response", {
    cause: error,
  });
}
