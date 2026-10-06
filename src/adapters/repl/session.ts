// The REPL session (spec repl): reads a line, runs a turn, renders its events,
// keeps the conversation, and turns Ctrl-C into cancellation. It's an adapter:
// it drives the core's runTurn and implements its Approver, and only
// main.ts knows it exists.

import { type Interface, createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AgentConfig } from "../../core/agent.ts";
import { runTurn } from "../../core/agent-loop.ts";
import type { Message, ToolCallBlock } from "../../core/conversation.ts";
import { PromptApprover } from "./prompt-approver.ts";
import { Renderer } from "./render.ts";

export type SessionDeps = {
  input: Readable;
  output: Writable;
  // Everything runTurn needs except the approver, which the session provides
  // itself: approval questions must go through its own input.
  agent: Omit<AgentConfig, "approver">;
  summarize: (call: ToolCallBlock) => Promise<string>;
  // True for a real terminal: readline then handles line editing, history
  // and Ctrl-C. False for tests and pipes.
  terminal?: boolean;
};

const PROMPT = "> ";

export class Session {
  readonly #deps: SessionDeps;
  readonly #rl: Interface;
  readonly #lines: LineReader;
  readonly #renderer = new Renderer();
  readonly #config: AgentConfig;
  // Replaced by the conversation each turn returns (spec "One turn per line").
  #conversation: readonly Message[] = [];
  // The running turn's controller, or undefined at the prompt: what Ctrl-C
  // does depends on which.
  #turn: AbortController | undefined;

  constructor(deps: SessionDeps) {
    this.#deps = deps;
    this.#rl = createInterface({
      input: deps.input,
      output: deps.output,
      terminal: deps.terminal ?? false,
    });
    this.#lines = new LineReader(this.#rl);
    // In a terminal, readline turns Ctrl-C into this event instead of
    // killing the process (Node's default for SIGINT).
    this.#rl.on("SIGINT", () => this.interrupt());

    const approver = new PromptApprover({
      summarize: deps.summarize,
      ask: (question, signal) => {
        // The question starts on a fresh line, after any streamed text.
        deps.output.write(this.#renderer.breakLine());
        // `fresh`: lines typed before the question appeared are dropped, so
        // nothing typed ahead can approve a call the user hasn't seen.
        return this.#lines.next(question, { signal, fresh: true }).then((line) => line ?? "");
      },
    });
    this.#config = { ...deps.agent, approver };
  }

  async run(): Promise<void> {
    try {
      for (;;) {
        const line = await this.#lines.next(PROMPT);
        // null: the input ended (Ctrl-D, or a closed pipe).
        if (line === null) {
          return;
        }
        const prompt = line.trim();
        if (prompt === "exit") {
          return;
        }
        if (prompt !== "") {
          await this.#runOneTurn(prompt);
        }
      }
    } finally {
      this.#rl.close();
    }
  }

  // Ctrl-C (spec "Ctrl-C cancels the turn, not the session").
  interrupt(): void {
    if (this.#turn !== undefined) {
      // The loop sees the aborted signal at its next checkpoint, the provider
      // and a running tool see it at once, and an open approval question
      // rejects. The turn then ends as cancelled and run() asks again.
      this.#turn.abort();
      return;
    }
    this.#deps.output.write(`\n(To quit, press Ctrl-D or type exit.)\n`);
    this.#rl.prompt();
  }

  async #runOneTurn(prompt: string): Promise<void> {
    const controller = new AbortController();
    this.#turn = controller;
    try {
      for await (const event of runTurn(
        this.#config,
        this.#conversation,
        prompt,
        controller.signal,
      )) {
        this.#deps.output.write(this.#renderer.render(event));
        if (event.type === "turn_ended") {
          this.#conversation = event.conversation;
        }
      }
    } catch (error: unknown) {
      // runTurn only throws for bugs (agent-loop design D1). The session
      // survives: the turn's changes are lost, the conversation stays as it
      // was before it, and the user can try again or quit.
      const message = error instanceof Error ? error.message : String(error);
      this.#deps.output.write(`${this.#renderer.breakLine()}[internal error: ${message}]\n`);
    } finally {
      this.#turn = undefined;
    }
  }
}

// Lines from readline, one at a time, for whoever asks next: the main prompt
// or an approval question. readline itself only offers events ("line",
// "close"); this turns them into "give me the next line", which also ends
// cleanly when the input closes and can be cancelled with a signal.
class LineReader {
  readonly #rl: Interface;
  // Lines that arrived while nobody was waiting (typed ahead).
  #buffered: string[] = [];
  #waiting: ((line: string | null) => void) | undefined;
  #closed = false;

  constructor(rl: Interface) {
    this.#rl = rl;
    rl.on("line", (line) => {
      if (this.#waiting !== undefined) {
        const deliver = this.#waiting;
        this.#waiting = undefined;
        deliver(line);
      } else {
        this.#buffered.push(line);
      }
    });
    rl.on("close", () => {
      this.#closed = true;
      this.#waiting?.(null);
      this.#waiting = undefined;
    });
  }

  // Shows `prompt` and resolves with the next line, or null once the input
  // has ended. Rejects if `signal` aborts first.
  next(
    prompt: string,
    options: { signal?: AbortSignal; fresh?: boolean } = {},
  ): Promise<string | null> {
    const { signal, fresh = false } = options;
    if (fresh) {
      this.#buffered = [];
    }
    // setPrompt + prompt rather than a plain write: in a terminal, readline
    // then knows the prompt and redraws it correctly while the user edits.
    this.#rl.setPrompt(prompt);
    this.#rl.prompt();

    const typedAhead = this.#buffered.shift();
    if (typedAhead !== undefined) {
      return Promise.resolve(typedAhead);
    }
    if (this.#closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.#waiting = undefined;
        reject(new DOMException("The question was interrupted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiting = (line) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(line);
      };
    });
  }
}
