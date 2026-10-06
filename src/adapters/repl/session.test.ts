// Tests for the REPL session (tools-and-repl, group 6; spec repl). The session
// runs with in-memory streams standing in for the terminal, a scripted model
// and scripted tools: everything a person would see and do, without one.
// Ctrl-C is simulated by calling interrupt(), which is what readline's SIGINT
// event triggers in a real terminal (a non-terminal stream never produces it).

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedProvider, type Script } from "../providers/fake/scripted-provider.ts";
import { ScriptedTool } from "../../../test/helpers/scripted-tool.ts";
import type { Tool } from "../../core/ports/tool.ts";
import type { StreamEvent } from "../../core/ports/model-provider.ts";
import { Session } from "./session.ts";

const text = (fragment: string): StreamEvent => ({ type: "text_delta", text: fragment });
const completed = (stopReason: "end_turn" | "tool_use" = "end_turn"): StreamEvent => ({
  type: "response_completed",
  stopReason,
  usage: { inputTokens: 1, outputTokens: 1 },
  skippedBlocks: 0,
});
const answer = (words: string): Script => ({ events: [text(words), completed()] });
const askForBash = (command: string): Script => ({
  events: [
    { type: "tool_call_started", id: "c1", toolName: "bash" },
    {
      type: "tool_call_completed",
      call: { type: "tool_call", id: "c1", toolName: "bash", input: { command } },
    },
    completed("tool_use"),
  ],
});

// Every session a test starts, so afterEach can make sure none is left
// waiting for input.
const running: { input: PassThrough; done: Promise<void> }[] = [];

function start(scripts: Script[], tools: Tool[] = []) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });
  const provider = new ScriptedProvider(scripts);
  const session = new Session({
    input,
    output,
    agent: { provider, tools, model: "test", maxOutputTokens: 100, maxSteps: 5 },
    summarize: (call) => Promise.resolve(`Run: ${JSON.stringify(call.input)}`),
  });
  const done = session.run();
  running.push({ input, done });

  return {
    session,
    provider,
    done,
    output: () => written,
    type: (line: string) => input.write(`${line}\n`),
    // Waits until the output contains `text`: the session works
    // asynchronously, so a test acts only once the session has reached the
    // point it's testing (the answer streaming, the question asked, ...).
    waitFor: async (expected: string) => {
      for (let attempt = 0; attempt < 200 && !written.includes(expected); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(written).toContain(expected);
    },
  };
}

afterEach(async () => {
  // Ending the input ends any session a failing test left running.
  for (const { input, done } of running.splice(0)) {
    input.end();
    await done;
  }
});

describe("Session: turns", () => {
  // Spec scenario "Two turns".
  it("keeps the conversation between turns", async () => {
    const repl = start([answer("Hello!"), answer("More.")]);

    repl.type("Hi");
    await repl.waitFor("Hello!");
    repl.type("And?");
    await repl.waitFor("More.");
    repl.type("exit");
    await repl.done;

    expect(repl.provider.requests[1]?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
      { role: "user", content: [{ type: "text", text: "And?" }] },
    ]);
  });

  it("shows a prompt, the streamed answer, and a new prompt", async () => {
    const repl = start([answer("Hello!")]);

    repl.type("Hi");
    await repl.waitFor("Hello!\n> ");
    repl.type("exit");
    await repl.done;

    expect(repl.output()).toBe("> Hello!\n> ");
  });

  it("ignores empty and blank lines", async () => {
    const repl = start([answer("Hello!")]);

    repl.type("");
    repl.type("   ");
    repl.type("exit");
    await repl.done;

    expect(repl.provider.requests).toEqual([]);
  });

  // Spec scenario "Exit".
  it("ends on exit without another request", async () => {
    const repl = start([]);

    repl.type("exit");
    await repl.done;

    expect(repl.provider.requests).toEqual([]);
  });

  it("ends when the input ends (Ctrl-D)", async () => {
    const repl = start([]);

    repl.type("  ");
    // end(): no more input, which is what Ctrl-D on an empty line means.
    (running.at(-1)?.input as PassThrough).end();

    await repl.done;
  });

  // A bug in the loop or a tool shouldn't take the whole session down.
  it("reports an unexpected error and carries on", async () => {
    // No script for the request: ScriptedProvider throws a plain Error.
    const repl = start([]);

    repl.type("Hi");
    await repl.waitFor("[internal error:");
    repl.type("exit");
    await repl.done;
  });
});

describe("Session: approval", () => {
  it("runs the tool when the user types y", async () => {
    const bash = new ScriptedTool("bash", { needsApproval: true });
    const repl = start([askForBash("ls"), answer("Listed.")], [bash]);

    repl.type("list files");
    await repl.waitFor("Allow? [y/N] ");
    repl.type("y");
    await repl.waitFor("Listed.");

    expect(bash.calls).toHaveLength(1);
    expect(repl.output()).toContain('Run: {"command":"ls"}\nAllow? [y/N] ');
  });

  // An answer typed before the question appeared must not count: the user
  // can't have seen what they were approving.
  it("doesn't take a line typed ahead as the answer", async () => {
    const bash = new ScriptedTool("bash", { needsApproval: true });
    const repl = start([askForBash("rm -rf build"), answer("Ok.")], [bash]);

    repl.type("clean up");
    repl.type("y");
    await repl.waitFor("Allow? [y/N] ");
    repl.type("n");
    await repl.waitFor("Ok.");

    expect(bash.calls).toEqual([]);
  });
});

describe("Session: Ctrl-C", () => {
  // Spec scenario "Cancel while streaming".
  it("cancels the turn while the answer streams, and asks for the next line", async () => {
    const repl = start([{ events: [text("Thinking")], ending: { type: "hang" } }, answer("Back.")]);

    repl.type("Hi");
    await repl.waitFor("Thinking");
    repl.session.interrupt();
    await repl.waitFor("[cancelled]\n> ");
    repl.type("again");
    await repl.waitFor("Back.");
  });

  // Spec scenario "Cancel at the approval question".
  it("cancels at the approval question without running the command", async () => {
    const bash = new ScriptedTool("bash", { needsApproval: true });
    const repl = start([askForBash("rm -rf build")], [bash]);

    repl.type("clean up");
    await repl.waitFor("Allow? [y/N] ");
    repl.session.interrupt();
    await repl.waitFor("[cancelled]\n> ");

    expect(bash.calls).toEqual([]);
  });

  it("at the prompt, explains how to quit and keeps going", async () => {
    const repl = start([answer("Still here.")]);
    await repl.waitFor("> ");

    repl.session.interrupt();
    await repl.waitFor("Ctrl-D");
    repl.type("Hi");
    await repl.waitFor("Still here.");
  });
});
