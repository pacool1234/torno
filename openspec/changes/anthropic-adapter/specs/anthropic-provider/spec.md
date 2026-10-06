## Purpose

How torno talks to any server that speaks the Anthropic Messages protocol (Anthropic's API, or local models through Ollama): the HTTP request it sends, how it reads the event stream, how failures, cancellation and timeouts surface, and how it's configured. It implements the `model-provider` contract.

## ADDED Requirements

### Requirement: Satisfies the provider contract

The Anthropic provider SHALL implement the `ModelProvider` port and SHALL pass the shared contract suite, run against recorded responses.

#### Scenario: Contract suite on recorded responses

- **WHEN** the shared contract suite runs with a factory that replays recorded Anthropic responses
- **THEN** every contract test passes

### Requirement: Request sent to the server

The provider SHALL send one `POST` to `<base URL>/v1/messages` with the headers `content-type: application/json` and `anthropic-version: 2023-06-01`, plus `x-api-key` when an API key is configured. The JSON body SHALL contain the model, `max_tokens`, `stream: true`, the system instructions only when given, the tools only when there is at least one, and the messages, mapped block by block:

- a text block becomes `{ "type": "text", "text" }`;
- a tool call becomes `{ "type": "tool_use", "id", "name", "input" }`;
- a tool result becomes `{ "type": "tool_result", "tool_use_id", "content", "is_error" }`.

A tool definition SHALL become `{ "name", "description", "input_schema" }`.

#### Scenario: Minimal request

- **WHEN** a request has model "claude-haiku-4-5", one user text message "Hi", no system instructions, no tools, and 100 maximum output tokens
- **THEN** the body is `{ "model": "claude-haiku-4-5", "max_tokens": 100, "stream": true, "messages": [{ "role": "user", "content": [{ "type": "text", "text": "Hi" }] }] }`, with no `system` and no `tools` keys

#### Scenario: Tool call and tool result are mapped

- **WHEN** the conversation contains an assistant tool call (id "call_1", name "read_file", input `{ "path": "a.ts" }`) and a user tool result for "call_1" with content "File not found", marked as an error
- **THEN** the body contains `{ "type": "tool_use", "id": "call_1", "name": "read_file", "input": { "path": "a.ts" } }` and `{ "type": "tool_result", "tool_use_id": "call_1", "content": "File not found", "is_error": true }`

#### Scenario: No API key

- **WHEN** no API key is configured (as with Ollama)
- **THEN** the request has no `x-api-key` header

### Requirement: Event stream parsing

The provider SHALL parse the response body as server-sent events: lines ending in LF or CRLF, events separated by a blank line, `event:` and `data:` fields, several `data:` lines joined with a line break, and lines starting with `:` ignored. Parsing SHALL give the same events however the body is split into chunks, including a split inside a line or inside a multi-byte UTF-8 character.

#### Scenario: Chunk boundaries don't matter

- **WHEN** the same recorded body is delivered whole, one byte at a time, and in chunks that split events, lines and multi-byte characters
- **THEN** the provider emits the same canonical events in all three cases

### Requirement: Untrusted events are validated

The JSON data of every event the provider uses SHALL be validated against a schema before use. Data that is not valid JSON, or doesn't match the schema of its event type, SHALL fail the stream with a provider error of kind `protocol`. Event types the provider doesn't use (such as `ping`, or types added to the protocol later) SHALL be ignored.

#### Scenario: Malformed event data

- **WHEN** a `content_block_delta` event's data is not valid JSON
- **THEN** consuming the stream throws a provider error of kind `protocol`

#### Scenario: Unknown event type

- **WHEN** the stream contains a `ping` event and an event of a type the provider doesn't know, between two text deltas
- **THEN** both text events are delivered and the stream completes normally

### Requirement: Text

Each `text_delta` SHALL become a text event with the same text, in order, except that an empty delta SHALL produce no event.

#### Scenario: Fragments rebuild the text

- **WHEN** the recorded stream sends the text deltas "The ", "answer ", "is 4."
- **THEN** the text events are "The ", "answer ", "is 4.", and joining them gives "The answer is 4."

#### Scenario: No empty fragments

- **WHEN** the stream sends an empty text delta between two non-empty ones
- **THEN** only the two non-empty text events are emitted

### Requirement: Tool calls assembled from partial JSON

When a `tool_use` content block starts, the provider SHALL emit "tool call started" with its id and name. It SHALL concatenate the block's `input_json_delta` fragments and, when the block stops, parse the result and emit "tool call completed" with the parsed input. An empty input SHALL be parsed as `{}`. Input that isn't valid JSON, or isn't a JSON object, SHALL fail the stream with a provider error of kind `protocol`.

#### Scenario: Input split across fragments

- **WHEN** a tool call "read_file" with id "toolu_1" streams its input as the fragments `{"pa`, `th": "a`, `.ts"}`
- **THEN** the provider emits "tool call started" (toolu_1, read_file), then "tool call completed" with input `{ path: "a.ts" }`

#### Scenario: Tool without arguments

- **WHEN** a tool call's input fragments are all empty
- **THEN** "tool call completed" carries the input `{}`

#### Scenario: Malformed tool input

- **WHEN** a tool call's concatenated input is `{"path": "a.ts"` (no closing brace)
- **THEN** consuming the stream throws a provider error of kind `protocol`, and no "tool call completed" event is emitted for it

### Requirement: Unsupported blocks are skipped and counted

A content block of any type other than `text` and `tool_use` (such as `thinking` or `redacted_thinking`) SHALL be skipped together with its deltas, and counted in the completion event's `skippedBlocks`.

#### Scenario: Thinking block before a tool call

- **WHEN** the response contains a `thinking` block, then a `tool_use` block
- **THEN** no event is emitted for the thinking block, the tool call is delivered, and the completion event reports 1 skipped block

### Requirement: Completion, stop reason and usage

When `message_stop` arrives, the provider SHALL emit one completion event and end the stream, without reading further. The stop reason SHALL be the last `stop_reason` received, mapped as: `end_turn`, `tool_use` and `max_tokens` unchanged; anything else to `other`. Usage SHALL take input tokens and, when present, cache read and cache write tokens from `message_start`, and output tokens from the last `message_delta`.

#### Scenario: Output limit reached

- **WHEN** a recorded response was cut off by `max_tokens`
- **THEN** the completion event's stop reason is `max_tokens`

#### Scenario: Cache counts only when reported

- **WHEN** `message_start` reports 50 input tokens, 0 cache read tokens and 1000 cache write tokens, and the last `message_delta` reports 20 output tokens
- **THEN** usage is 50 input, 20 output, 0 cache read and 1000 cache write tokens

#### Scenario: No cache information

- **WHEN** `message_start` reports input tokens but no cache fields (as Ollama does)
- **THEN** usage has no cache counts

#### Scenario: Other stop reasons

- **WHEN** the stop reason is `stop_sequence` or `refusal`
- **THEN** the completion event's stop reason is `other`

### Requirement: Failures map to provider error kinds

A response with a non-2xx HTTP status SHALL fail before any event, with the kind chosen by status: 401, 402 and 403 → `auth`; 429 → `rate_limit`; 500, 502, 503, 504 and 529 → `overloaded`; any other status → `invalid_request`. The error message SHALL include the server's error message when the body provides one. An `error` event in the stream SHALL fail it with the kind chosen by the error's type (`authentication_error`, `permission_error` and `billing_error` → `auth`; `rate_limit_error` → `rate_limit`; `overloaded_error` and `api_error` → `overloaded`; any other type → `invalid_request`). A failure to connect, or to read the body, SHALL fail with `network`. A body that ends before `message_stop` SHALL fail with `network`.

#### Scenario: Failure before the first event

- **WHEN** the server answers HTTP 401 with an `authentication_error` body
- **THEN** consuming the stream throws a provider error of kind `auth` whose message includes the server's message, and no event was received

#### Scenario: Overloaded mid-stream

- **WHEN** the stream sends a text delta, then an `error` event of type `overloaded_error`
- **THEN** the text event is delivered, then consuming the stream throws a provider error of kind `overloaded`

#### Scenario: Connection dropped

- **WHEN** the body ends after a text delta, before `message_stop`
- **THEN** the text event is delivered, then consuming the stream throws a provider error of kind `network`

### Requirement: Cancellation and idle timeout

The request's signal SHALL cancel the HTTP request and the body read; a cancellation SHALL surface as kind `aborted`. If no bytes arrive for the configured idle time (default 60 seconds), while waiting for the response or between chunks of the body, the request SHALL be cancelled and the stream SHALL fail with kind `timeout`.

#### Scenario: Stalled stream

- **WHEN** the body delivers one text delta and then nothing for longer than the idle time
- **THEN** the text event is delivered, then consuming the stream throws a provider error of kind `timeout`

#### Scenario: Timer reset by data

- **WHEN** chunks keep arriving, each within the idle time, for longer than the idle time in total
- **THEN** the stream completes normally

### Requirement: Resources released

However the stream ends (completion, failure, cancellation, timeout, or the consumer stopping early), the provider SHALL cancel the response body if it's still open and clear its idle timer.

#### Scenario: Consumer stops after the first event

- **WHEN** the consumer leaves its `for await` loop after the first text event
- **THEN** the response body is cancelled and no timer is left running

### Requirement: Configuration from the environment

A configuration loader SHALL read `ANTHROPIC_API_KEY` (optional), `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`) and `TORNO_MODEL` (default `claude-haiku-4-5`) from a given environment object, validate them, and return typed settings. An invalid base URL SHALL be rejected with a message naming the variable, and never including the API key.

#### Scenario: Defaults

- **WHEN** the environment sets none of the three variables
- **THEN** the settings have no API key, base URL `https://api.anthropic.com` and model `claude-haiku-4-5`

#### Scenario: Ollama

- **WHEN** `ANTHROPIC_BASE_URL` is `http://localhost:11434` and `TORNO_MODEL` is `gemma4:e4b`
- **THEN** the settings use that base URL and model

#### Scenario: Invalid base URL

- **WHEN** `ANTHROPIC_BASE_URL` is `not a url` and `ANTHROPIC_API_KEY` is set
- **THEN** loading fails with a message that names `ANTHROPIC_BASE_URL` and does not contain the key's value
