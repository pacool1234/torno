## Purpose

How torno runs one user message to completion: the steps it takes, the events it emits, how it runs and approves tools, how limits, failures and cancellation end a turn, and the conversation it leaves behind. Implemented in `src/core/` against the `model-provider` port and the tool and approver ports.

## ADDED Requirements

### Requirement: One turn per user message

`runTurn` SHALL add the prompt to the conversation, then repeat steps (one model request, then the tools it asked for) until the turn ends. It SHALL yield agent events as they happen and SHALL end with exactly one `turn_ended` event carrying the reason and the updated conversation. Limits, provider failures and cancellation SHALL be reported as reasons, never thrown. The prompt SHALL be added as a new user message, or appended as a text block to the last message when the conversation ends with a user message.

#### Scenario: Text-only answer

- **WHEN** the conversation is empty, the prompt is "Hi", and the model streams "Hel", "lo" and completes with `end_turn`
- **THEN** the events are text "Hel", text "lo", "step completed" (step 1, `end_turn`, with usage), then "turn ended" with reason `completed`
- **AND** the conversation is a user message "Hi" followed by an assistant message with the text "Hello"

#### Scenario: Conversation ending with a user message

- **WHEN** the conversation ends with a user message holding tool results, and the prompt is "continue"
- **THEN** the request sent to the model ends with that same user message, now with a text block "continue" after the results

#### Scenario: Empty response

- **WHEN** the model completes with `end_turn` and no text or tool calls
- **THEN** the turn ends with reason `completed` and no assistant message is added

### Requirement: Request sent to the model

Each step SHALL send the model, system instructions, the definitions of all configured tools, `maxOutputTokens`, the turn's signal and the whole conversation so far.

#### Scenario: Second step sees the tool results

- **WHEN** step 1 asks for a tool call and the tool returns "file contents"
- **THEN** step 2's request ends with the assistant message holding the call, then a user message holding its result

### Requirement: Tool calls run in order, results in one message

When a step completes with stop reason `tool_use`, the loop SHALL run its tool calls one at a time, in the order the model gave them, emitting "tool started" before and "tool finished" after each. It SHALL then add one user message holding every call's result, in call order, and start the next step. An unknown tool name, or a tool that throws, SHALL produce an error result and the loop SHALL continue.

#### Scenario: Two calls in one step

- **WHEN** the model asks for calls A then B in one response
- **THEN** B starts only after A has finished, and the next request contains one user message with A's result then B's result

#### Scenario: Unknown tool

- **WHEN** the model calls a tool name that isn't configured
- **THEN** no tool runs, its result is an error naming the unknown tool, and the next step starts

#### Scenario: Tool throws

- **WHEN** a tool throws an error with message "disk full"
- **THEN** its result is an error containing "disk full", and the next step starts

### Requirement: Approval before tools that need it

Before running a call whose tool needs approval, the loop SHALL ask the approver, passing the call and the turn's signal. A denied call SHALL NOT run; its result SHALL be the error "The user denied this tool call.", and the loop SHALL continue with the next call. Calls whose tool doesn't need approval SHALL run without asking.

#### Scenario: Read without asking

- **WHEN** the model calls a tool that doesn't need approval
- **THEN** the approver is not asked and the tool runs

#### Scenario: Denied call

- **WHEN** the approver denies a call to a tool that needs approval
- **THEN** the tool doesn't run, "tool finished" carries the denial as an error result, and the next step starts

### Requirement: Limits stop the turn

The loop SHALL make at most `maxSteps` model requests per turn. When the last allowed step asks for tools, the loop SHALL run them, keep their results, and end with reason `step_limit`. A response with stop reason `max_tokens` SHALL end the turn with reason `max_tokens`, keeping its text; tool calls in it SHALL NOT run and SHALL get the error result "Not run: the response hit the output limit."

#### Scenario: Step limit

- **WHEN** `maxSteps` is 2 and the model asks for a tool in every response
- **THEN** the model is called exactly twice, both steps' tools run, and the turn ends with reason `step_limit` with both steps' results in the conversation

#### Scenario: Output limit

- **WHEN** the model streams "The answer" and completes with `max_tokens`
- **THEN** the turn ends with reason `max_tokens` and the conversation ends with an assistant message "The answer"

### Requirement: Provider failures end the turn

A provider error other than `aborted` SHALL end the turn with reason `failed` and the error. The loop SHALL NOT retry. Finished steps SHALL stay in the conversation; the step in progress SHALL be dropped.

#### Scenario: Failure in the second step

- **WHEN** step 1 completes with a tool call, and step 2 streams some text then fails with kind `overloaded`
- **THEN** the turn ends with reason `failed` and that error, the model was called exactly twice, and the conversation holds the prompt, step 1's call and its result, and nothing from step 2

### Requirement: Cancellation

The turn's signal SHALL reach the provider, the approver and the running tool. When it aborts before the model has ended its turn, the turn SHALL end with reason `cancelled`, with no further model request or tool run. Once the model has ended its turn (a final response with no tool calls to run), a later abort SHALL NOT change the reason: there is nothing left to cancel. A response that hadn't completed SHALL be dropped. If the stop happens while a step's tools run, the running tool's outcome SHALL be recorded as its result, and every call not yet run SHALL get the error result "Not run: the user cancelled."

#### Scenario: Cancelled while streaming

- **WHEN** the signal aborts after the first text event of step 1
- **THEN** the turn ends with reason `cancelled`, and the conversation holds only the user's prompt

#### Scenario: Cancelled while a tool runs

- **WHEN** a step asks for calls A and B, and the signal aborts while A runs
- **THEN** A receives the aborted signal, A's outcome is its result, B doesn't run and gets the "Not run" result, and no further model request is made

#### Scenario: Cancelled after the final answer

- **WHEN** the model completes with `end_turn`, and the signal aborts while the "step completed" event is being handled
- **THEN** the turn ends with reason `completed`, keeping the answer

#### Scenario: Cancelled at the approval prompt

- **WHEN** the signal aborts while the approver is being asked about call A
- **THEN** A doesn't run, A and every later call get the "Not run" result, and the turn ends with reason `cancelled`

### Requirement: Tool results are capped

A tool result longer than 30,000 characters SHALL be shortened to its first 15,000 and last 15,000 characters, with a note between them giving the number of characters left out (ADR-0008). The cut SHALL NOT split a UTF-16 surrogate pair. The capped result SHALL be the one sent to the model and the one in the "tool finished" event.

#### Scenario: Large output

- **WHEN** a tool returns 100,000 characters
- **THEN** its result starts with the output's first 15,000 characters, ends with its last 15,000, and the note between them says 70,000 characters were left out

#### Scenario: Emoji at the cut

- **WHEN** a tool's long output has a surrogate pair straddling the head's last position
- **THEN** the result contains no unpaired surrogate

### Requirement: The returned conversation is valid

Whatever the reason a turn ends, the conversation in `turn_ended` SHALL start with a user message, alternate roles, and give every tool call exactly one result, in the user message right after the assistant message holding the call.

#### Scenario: Every ending

- **WHEN** a turn ends with each of the reasons `completed`, `step_limit`, `max_tokens`, `failed` and `cancelled`
- **THEN** the returned conversation satisfies these rules
