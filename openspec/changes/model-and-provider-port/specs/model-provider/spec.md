## Purpose

The contract every model provider satisfies: given a conversation, stream back the model's response as a sequence of provider-independent events, and finish, fail or be cancelled in a predictable way.

## ADDED Requirements

### Requirement: Provider request

A provider SHALL accept a request containing: a model identifier, optional system instructions, the conversation messages (at least one; a request without messages SHALL be rejected by the type checker), zero or more tool definitions (each with a name, a description and an input schema), a maximum number of output tokens, and a cancellation signal.

#### Scenario: Request without tools

- **WHEN** a request is sent with a model, one user message, no tool definitions and a maximum of 100 output tokens
- **THEN** the provider accepts it and returns a response stream

### Requirement: Response is consumed as an ordered stream

A provider SHALL return the response as an asynchronous sequence of events, consumed in order with `for await`. Each event SHALL be delivered exactly once.

#### Scenario: Text-only response

- **WHEN** the model answers "Hi there" in two fragments, "Hi" and " there", then finishes
- **THEN** the consumer receives a text event "Hi", a text event " there", and a completion event, in that order, and the stream ends

### Requirement: Text arrives as non-empty fragments

Text SHALL be delivered as text events, each carrying a non-empty fragment. Concatenating all text fragments of a response, in order, SHALL produce the complete text.

#### Scenario: Fragments rebuild the text

- **WHEN** the model answers with fragments "The ", "answer ", "is 4."
- **THEN** concatenating the text events gives "The answer is 4."

#### Scenario: No empty fragments

- **WHEN** the underlying provider sends an empty text fragment
- **THEN** no text event is emitted for it

### Requirement: Tool calls are announced, then delivered complete

For each tool call, the provider SHALL emit a "tool call started" event with the call's id and tool name, and later exactly one "tool call completed" event with the same id, the tool name and the input as a fully parsed object. Partial or unparsed tool input SHALL never be emitted.

#### Scenario: One tool call

- **WHEN** the model calls tool "read_file" with id "call_1" and input `{ "path": "a.ts" }`
- **THEN** the consumer receives "tool call started" (call_1, read_file), then "tool call completed" (call_1, read_file, `{ path: "a.ts" }`)

#### Scenario: Text before a tool call

- **WHEN** the model writes "Let me check." and then calls tool "read_file"
- **THEN** the text events come before the "tool call started" event

### Requirement: Completion is the last event

A successful response SHALL end with exactly one completion event, carrying a stop reason and token usage. No event SHALL follow it, and the stream SHALL end after it.

#### Scenario: Nothing after completion

- **WHEN** a response completes
- **THEN** the completion event is the last event received, and the stream then ends

### Requirement: Stop reasons

The completion event SHALL carry one of these stop reasons: `end_turn` (the model finished its answer), `tool_use` (the model is waiting for tool results), `max_tokens` (the output limit was reached), or `other` (any reason the provider reports that is not one of the above).

#### Scenario: Stopped to use a tool

- **WHEN** the model's response ends with a tool call
- **THEN** the completion event's stop reason is `tool_use`

#### Scenario: Output limit reached

- **WHEN** the model's output is cut off by the maximum output tokens
- **THEN** the completion event's stop reason is `max_tokens`

### Requirement: Token usage

The completion event SHALL report the number of input tokens and output tokens. It SHALL also report tokens read from and written to the provider's prompt cache when the provider reports them, and SHALL omit them when it does not.

#### Scenario: Usage is reported

- **WHEN** a response used 1200 input tokens and 80 output tokens, with no cache information from the provider
- **THEN** the completion event reports 1200 input and 80 output tokens, and no cache counts

### Requirement: Unknown content is skipped and counted

When the underlying provider sends a type of content the canonical model does not support, the provider SHALL skip it without failing, and the completion event SHALL report how many such blocks were skipped.

#### Scenario: Unsupported block type

- **WHEN** the model's response contains one unsupported block between two text fragments
- **THEN** both text fragments are delivered, the stream completes normally, and the completion event reports 1 skipped block

### Requirement: Failures surface as typed provider errors

When a response cannot be completed, consuming the stream SHALL throw a provider error with exactly one kind: `auth`, `rate_limit`, `overloaded`, `invalid_request`, `network`, `timeout`, `protocol` or `aborted`. Events received before the failure SHALL remain valid. No completion event SHALL be emitted for a failed response.

#### Scenario: Failure before the first event

- **WHEN** the provider rejects the request because of an invalid API key
- **THEN** consuming the stream throws a provider error of kind `auth`, and no event was received

#### Scenario: Failure after some text

- **WHEN** the connection drops after the text fragment "Hel" was delivered
- **THEN** the consumer has received the text event "Hel", then consuming the stream throws a provider error of kind `network`, and no completion event is received

#### Scenario: Malformed tool input

- **WHEN** the underlying provider sends tool input that is not valid JSON
- **THEN** consuming the stream throws a provider error of kind `protocol`

### Requirement: Retryable error kinds

The error kinds `rate_limit`, `overloaded`, `network` and `timeout` SHALL be classified as retryable. The kinds `auth`, `invalid_request`, `protocol` and `aborted` SHALL be classified as not retryable.

#### Scenario: A retryable kind

- **WHEN** an error's kind is `overloaded`
- **THEN** it is classified as retryable

#### Scenario: A non-retryable kind

- **WHEN** an error's kind is `auth`
- **THEN** it is classified as not retryable

### Requirement: Cancellation

When the request's cancellation signal fires, the provider SHALL stop emitting events and consuming the stream SHALL throw a provider error of kind `aborted`. If the signal has already fired when the request is made, the error SHALL be thrown before any event. Once the completion event has been delivered, the response is complete: a signal that fires afterwards SHALL NOT cause an error, and the stream SHALL end normally.

#### Scenario: Cancelled mid-response

- **WHEN** the signal fires after the text event "Hel" was received
- **THEN** no further events are received, and consuming the stream throws a provider error of kind `aborted`

#### Scenario: Cancelled before starting

- **WHEN** a request is made with a signal that has already fired
- **THEN** consuming the stream throws a provider error of kind `aborted` before any event

#### Scenario: Cancelled after completion

- **WHEN** the signal fires after the completion event was received
- **THEN** no error is thrown, and the stream ends normally

### Requirement: Consumer can stop early

When the consumer stops consuming the stream before it ends, the provider SHALL release its resources (such as open connections) without throwing an error.

#### Scenario: Consumer breaks after the first event

- **WHEN** the consumer exits its `for await` loop after the first text event
- **THEN** no error is thrown, and the provider reports that it released its resources

### Requirement: Scripted provider for tests

A scripted provider SHALL be available for tests. It SHALL replay a given script of events, optionally ending in a failure of a given kind or never finishing until cancelled, and SHALL satisfy every requirement of this contract that can be expressed in canonical events.

#### Scenario: Scripted failure after events

- **WHEN** the scripted provider is given the events "Hi", " there" followed by a `network` failure
- **THEN** the consumer receives "Hi" and " there", then consuming the stream throws a provider error of kind `network`

#### Scenario: Scripted provider waits for cancellation

- **WHEN** the scripted provider is told never to finish, and the signal fires after the first event
- **THEN** consuming the stream throws a provider error of kind `aborted`
