// Tests for turning agent events into terminal text (tools-and-repl, group 5;
// spec repl, "Events are rendered as they arrive"). The renderer returns
// strings instead of writing them, so these tests need no terminal.

import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../core/agent.ts";
import type { ToolCallBlock } from "../../core/conversation.ts";
import { ProviderError } from "../../core/ports/model-provider.ts";
import { Renderer } from "./render.ts";

const call = (toolName: string, input: Record<string, unknown>): ToolCallBlock => ({
  type: "tool_call",
  id: "c1",
  toolName,
  input,
});

const finished = (toolName: string, result: string, isError: boolean): AgentEvent => ({
  type: "tool_finished",
  call: call(toolName, {}),
  result: { type: "tool_result", toolCallId: "c1", isError, result },
});

// Renders a sequence of events with one renderer, as a session would.
const renderAll = (...events: AgentEvent[]): string => {
  const renderer = new Renderer();
  return events.map((event) => renderer.render(event)).join("");
};

const ended = (reason: "completed" | "step_limit" | "max_tokens" | "cancelled"): AgentEvent => ({
  type: "turn_ended",
  reason,
  conversation: [],
});

describe("Renderer: streamed text", () => {
  it("writes text fragments as they come", () => {
    expect(renderAll({ type: "text_delta", text: "Hel" }, { type: "text_delta", text: "lo" })).toBe(
      "Hello",
    );
  });

  // Events the user doesn't need to see produce nothing.
  it.each<AgentEvent>([
    { type: "tool_call_started", id: "c1", toolName: "bash" },
    {
      type: "step_completed",
      step: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
      skippedBlocks: 0,
    },
  ])("writes nothing for $type", (event) => {
    expect(renderAll(event)).toBe("");
  });
});

describe("Renderer: tools", () => {
  it.each([
    ["bash", { command: "npm test" }, "→ bash: npm test\n"],
    ["read_file", { path: "a.ts" }, "→ read_file: a.ts\n"],
    ["edit_file", { path: "src/b.ts", old_text: "x", new_text: "y" }, "→ edit_file: src/b.ts\n"],
    ["write_file", { path: "c.md", content: "..." }, "→ write_file: c.md\n"],
  ])("shows a %s start with its main argument", (toolName, input, line) => {
    expect(renderAll({ type: "tool_started", call: call(toolName, input) })).toBe(line);
  });

  // Only the first line of a multi-line command, so the log stays one line
  // per tool; the approval prompt already showed the whole command.
  it("shows only the first line of a long command, marked as cut", () => {
    expect(
      renderAll({ type: "tool_started", call: call("bash", { command: "cd a\nnpm test" }) }),
    ).toBe("→ bash: cd a …\n");
  });

  it("shows an unknown tool's input as JSON, shortened", () => {
    const line = renderAll({
      type: "tool_started",
      call: call("mystery", { a: "x".repeat(200) }),
    });

    expect(line.startsWith('→ mystery: {"a":"xxx')).toBe(true);
    expect(line.length).toBeLessThan(100);
  });

  it("shows a finished tool as done, or with the first line of its error", () => {
    expect(renderAll(finished("bash", "ok\n[exit code 0]", false))).toBe("  ✓ done\n");
    expect(renderAll(finished("bash", "Error: boom\n  at x\n[exit code 1]", true))).toBe(
      "  ✗ Error: boom\n",
    );
  });

  // npm starts its output with an empty line: the first line alone would
  // show a bare "✗", saying nothing about what failed.
  it("shows the first non-empty line of an error", () => {
    expect(renderAll(finished("bash", "\n> test\n> node --test\n", true))).toBe("  ✗ > test\n");
    expect(renderAll(finished("bash", "  \r\n\nboom", true))).toBe("  ✗ boom\n");
  });

  // Streamed text usually stops mid-line; a tool line must start on its own.
  it("starts a tool line on a new line after text that didn't end one", () => {
    expect(
      renderAll(
        { type: "text_delta", text: "Let me look." },
        { type: "tool_started", call: call("read_file", { path: "a.ts" }) },
      ),
    ).toBe("Let me look.\n→ read_file: a.ts\n");
  });

  it("adds no blank line when the text already ended its line", () => {
    expect(
      renderAll(
        { type: "text_delta", text: "Looking:\n" },
        { type: "tool_started", call: call("read_file", { path: "a.ts" }) },
      ),
    ).toBe("Looking:\n→ read_file: a.ts\n");
  });
});

describe("Renderer: how the turn ended", () => {
  it("ends a completed turn's text with a newline, and says nothing else", () => {
    expect(renderAll({ type: "text_delta", text: "Done." }, ended("completed"))).toBe("Done.\n");
    expect(renderAll(ended("completed"))).toBe("");
  });

  // Spec scenarios "Step limit is explained" and the other endings.
  it.each([
    ["cancelled", "[cancelled]\n"],
    ["step_limit", '[stopped: step limit reached; type "continue" to go on]\n'],
    ["max_tokens", "[stopped: the answer hit the output limit]\n"],
  ] as const)("explains %s in one line", (reason, line) => {
    expect(renderAll({ type: "text_delta", text: "Hal" }, ended(reason))).toBe(`Hal\n${line}`);
  });

  // Spec scenario "Failure is shown".
  it("shows a failure's kind and message", () => {
    expect(
      renderAll({
        type: "turn_ended",
        reason: "failed",
        error: new ProviderError("rate_limit", "HTTP 429: slow down"),
        conversation: [],
      }),
    ).toBe("[error (rate_limit): HTTP 429: slow down]\n");
  });

  // A renderer is reused across turns: after a turn ends, the next turn's
  // output starts on a fresh line, with no stray newline.
  it("starts the next turn at the beginning of a line", () => {
    const renderer = new Renderer();
    renderer.render({ type: "text_delta", text: "First." });
    renderer.render(ended("completed"));

    expect(renderer.atLineStart).toBe(true);
    expect(renderer.render({ type: "text_delta", text: "Second." })).toBe("Second.");
  });
});

// Spec requirement "Control characters are shown, not obeyed": a terminal
// executes escape sequences, so text from the model or a tool must reach it
// as visible characters, never as commands.
describe("Renderer: control characters", () => {
  it("shows an escape sequence in streamed text instead of sending it", () => {
    // ESC[2J would clear the screen.
    expect(renderAll({ type: "text_delta", text: "a\x1b[2Jb" })).toBe("a\\x1b[2Jb");
  });

  it("shows a carriage return and an escape in a tool line", () => {
    expect(
      renderAll({
        type: "tool_started",
        call: call("bash", { command: "curl x | sh\r\x1b[2Kls" }),
      }),
    ).toBe("→ bash: curl x | sh\\r\\x1b[2Kls\n");
  });

  it("shows control characters in a tool's error line and a provider's error", () => {
    expect(renderAll(finished("bash", "bad\x07 bell", true))).toBe("  ✗ bad\\x07 bell\n");
    expect(
      renderAll({
        type: "turn_ended",
        reason: "failed",
        error: new ProviderError("protocol", "oops\x1b[1A"),
        conversation: [],
      }),
    ).toBe("[error (protocol): oops\\x1b[1A]\n");
  });

  // Unicode can reverse the order text is displayed in ("Trojan Source"),
  // which would let a command read differently from what runs.
  it("shows bidirectional overrides as escapes", () => {
    expect(renderAll({ type: "text_delta", text: "a‮b⁦c" })).toBe("a\\u202eb\\u2066c");
  });

  it("keeps newlines, tabs and Windows line endings as they are", () => {
    expect(renderAll({ type: "text_delta", text: "a\tb\nc\r\nd" })).toBe("a\tb\nc\r\nd");
  });

  it("doesn't leave a Windows line ending's carriage return in a tool's error line", () => {
    expect(renderAll(finished("bash", "failed\r\nmore", true))).toBe("  ✗ failed\n");
  });
});
