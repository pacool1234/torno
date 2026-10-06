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
        return visible(event.text);
      // Not shown: the tool's own line follows once it starts, and a step's
      // usage is for telemetry (week 2), not for the user.
      case "tool_call_started":
      case "step_completed":
        return "";
      case "tool_started":
        return this.line(visible(`→ ${event.call.toolName}: ${mainArgument(event.call)}`));
      case "tool_finished":
        return this.line(
          event.result.isError ? `  ✗ ${visible(firstLine(event.result.result))}` : "  ✓ done",
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
        return this.line(visible(`[error (${event.error.kind}): ${event.error.message}]`));
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

// `\r?\n`: a Windows line ending (common in command output) ends the line
// too, rather than leaving its carriage return behind.
function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? "";
}

// What a terminal would obey rather than show (spec "Control characters are
// shown, not obeyed"):
// - C0 controls except tab and newline: ESC starts sequences that move the
//   cursor, erase lines or retitle the window; a lone carriage return goes
//   back to the line's start, so what follows overwrites what came before.
//   One followed by a newline is just a Windows line ending, and harmless.
// - DEL and the C1 controls (U+0080–U+009F): some terminals treat U+009B
//   as ESC [.
// - Unicode's bidirectional controls: they change the order text is
//   displayed in ("Trojan Source"), so `rm a #\u202e...` could read as
//   something else.
// A regex over UTF-16 code units: every character listed is a single unit.
const UNSAFE =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point.
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]|\r(?!\n)/g;

// Replaces each unsafe character with an escape that shows its code: \x1b
// for one below U+0100, \u202e above, and \r for a carriage return, the one
// most people recognise by name. Every piece of text that came from
// the model, a tool or the provider goes through this before the terminal
// sees it; the session's own text ("> ", "[cancelled]") doesn't need to.
// Stateless, so streamed fragments can be escaped one by one; the only cost
// is that a Windows line ending split between two fragments shows as \r.
export function visible(text: string): string {
  return text.replace(UNSAFE, (char) => {
    if (char === "\r") {
      return "\\r";
    }
    const code = char.charCodeAt(0);
    return code < 0x100
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}
