// Turns agent events into terminal text (spec repl, "Events are rendered as
// they arrive"). It returns strings rather than writing them: the session
// decides where they go, and tests check them without a terminal.

import type { AgentEvent, TurnEnded } from "../../core/agent.ts";
import type { ToolCallBlock } from "../../core/conversation.ts";

// Long enough to recognise a call, short enough to keep one line per tool.
const MAX_ARGUMENT_CHARS = 60;

export class Renderer {
  // Whether the cursor is at the start of a line. Streamed text often stops
  // mid-line ("Let me look."), and a tool line or an ending must not be
  // glued to it. Public so the session can put the approval question on a
  // fresh line too.
  atLineStart = true;

  render(event: AgentEvent): string {
    switch (event.type) {
      case "text_delta":
        this.atLineStart = event.text.endsWith("\n");
        return event.text;
      // Not shown: the tool's own line follows once it starts, and a step's
      // usage is for telemetry (week 2), not for the user.
      case "tool_call_started":
      case "step_completed":
        return "";
      case "tool_started":
        return this.line(`→ ${event.call.toolName}: ${mainArgument(event.call)}`);
      case "tool_finished":
        return this.line(
          event.result.isError ? `  ✗ ${firstLine(event.result.result)}` : "  ✓ done",
        );
      case "turn_ended":
        return this.ending(event);
      default: {
        const unhandled: never = event;
        throw new Error(`Unhandled agent event: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  // The separator a session writes before its own output (the approval
  // question): a newline if the cursor is mid-line, else nothing.
  breakLine(): string {
    const prefix = this.atLineStart ? "" : "\n";
    this.atLineStart = true;
    return prefix;
  }

  // A whole line, starting on a fresh one if needed.
  private line(text: string): string {
    return `${this.breakLine()}${text}\n`;
  }

  private ending(event: TurnEnded): string {
    switch (event.reason) {
      // A normal end needs no comment; just leave the cursor on a new line
      // for the next prompt.
      case "completed":
        return this.breakLine();
      case "cancelled":
        return this.line("[cancelled]");
      case "step_limit":
        return this.line('[stopped: step limit reached; type "continue" to go on]');
      case "max_tokens":
        return this.line("[stopped: the answer hit the output limit]");
      case "failed":
        return this.line(`[error (${event.error.kind}): ${event.error.message}]`);
      default: {
        const unhandled: never = event;
        throw new Error(`Unhandled turn ending: ${JSON.stringify(unhandled)}`);
      }
    }
  }
}

// The one argument that identifies a call: the command for bash, the path for
// file tools. Other tools (or malformed input) show their input as JSON. Reads
// the raw input defensively: nothing here has been validated yet.
function mainArgument(call: ToolCallBlock): string {
  const { command, path } = call.input;
  if (call.toolName === "bash" && typeof command === "string") {
    return shorten(command);
  }
  if (typeof path === "string") {
    return shorten(path);
  }
  return shorten(JSON.stringify(call.input));
}

// First line only, cut to MAX_ARGUMENT_CHARS, with "…" when anything was
// left out, so the user can tell the line isn't the whole thing.
function shorten(text: string): string {
  const first = firstLine(text);
  const cut = first.length > MAX_ARGUMENT_CHARS ? first.slice(0, MAX_ARGUMENT_CHARS) : first;
  return cut === text ? cut : `${cut} …`;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}
