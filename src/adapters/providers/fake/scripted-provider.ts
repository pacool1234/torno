import {
  type ModelProvider,
  ProviderError,
  type ProviderErrorKind,
  type ProviderRequest,
  type StreamEvent,
} from "../../../core/ports/model-provider.ts";

export type ScriptEnding =
  { type: "end" } | { type: "fail"; kind: ProviderErrorKind } | { type: "hang" };

export type Script = {
  events: readonly StreamEvent[];
  ending?: ScriptEnding;
};

export class ScriptedProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];

  #openStreams = 0;

  get openStreams(): number {
    return this.#openStreams;
  }

  readonly #scripts: readonly Script[];
  #nextScript = 0;

  constructor(scripts: readonly Script[]) {
    this.#scripts = scripts;
  }

  stream(request: ProviderRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const callNumber = this.#nextScript + 1;
    const script = this.#scripts[this.#nextScript];
    this.#nextScript += 1;

    return this.#play(script, callNumber, request.signal);
  }

  async *#play(
    script: Script | undefined,
    callNumber: number,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    this.#openStreams += 1;
    let removeAbortListener: (() => void) | undefined;

    try {
      if (script === undefined) {
        throw new Error(
          `ScriptedProvider: stream() call #${callNumber} has no script (only ${this.#scripts.length} were given)`,
        );
      }

      for (const event of script.events) {
        throwIfAborted(signal);
        yield event;
      }
      throwIfAborted(signal);

      const ending = script.ending ?? { type: "end" };
      switch (ending.type) {
        case "end":
          return;
        case "fail":
          throw new ProviderError(ending.kind, `Scripted ${ending.kind} failure`);
        case "hang":
          await new Promise<never>((_resolve, reject) => {
            const onAbort = (): void => {
              reject(abortedError(signal));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => {
              signal.removeEventListener("abort", onAbort);
            };
          });
          return;
        default: {
          const unhandled: never = ending;
          throw new Error(`Unhandled script ending: ${JSON.stringify(unhandled)}`);
        }
      }
    } finally {
      removeAbortListener?.();
      this.#openStreams -= 1;
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortedError(signal);
  }
}

function abortedError(signal: AbortSignal): ProviderError {
  return new ProviderError("aborted", "The request was cancelled", { cause: signal.reason });
}
