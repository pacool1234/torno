# Design

> **Status: decided (2026-10-02).** D1–D6 were decided by Francisco; the options not chosen stay below as the record of alternatives considered.

## Context

See `proposal.md` for motivation. Constraints from the ADRs:

- The core performs no I/O and owns its ports (ADR-0001).
- Messages and events are discriminated unions with exhaustive `switch` checks; untrusted data is validated at the edges, so the core only ever sees well-formed values (ADR-0002).
- The canonical model is block-based, closer to Anthropic's shape (ADR-0003).
- No syntax that Node can't strip: no `enum`, no parameter properties (ADR-0006).

## Goals / Non-Goals

**Goals:**

- A contract precise enough that two very different adapters (Anthropic, OpenAI-compatible) can satisfy it without leaking their formats into the core.
- A contract that can be tested without network access.

**Non-Goals:**

- The agent loop and what it does with the events (Phase 2).
- Parsing any real provider's stream (change 3).
- Cost calculation (change 5). This change only carries token counts.
- Images, documents, or other non-text input.

## Decisions

### D1. How the provider delivers events — decided: A

| Option                                                                                                      | Pros                                                                                                                                                                                                                                  | Cons                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **A. Async iterator** — the provider returns something you consume with `for await (const event of stream)` | Pull-based: the producer can't outrun the consumer. Errors surface as exceptions at the `for await`, so `try/catch` works naturally. Breaking out of the loop tells the producer to stop. Easy to test: collect events into an array. | One consumer per stream; feeding several (UI + log) needs a small fan-out step.                                                |
| B. Callbacks — `onText`, `onToolCall`, `onError`, `onDone` passed in                                        | Familiar, simple for one consumer.                                                                                                                                                                                                    | Easy to forget a callback; error handling spread across functions; ordering bugs are harder to test; no natural "stop" signal. |
| C. Event emitter (Node's `EventEmitter`)                                                                    | Many listeners for free.                                                                                                                                                                                                              | Push-based: no back-pressure. An `error` event with no listener crashes the process. Weakly typed by default.                  |

**Decision: A.** It's the idiomatic way to model a stream in modern JavaScript, and it makes ordering and error scenarios straightforward to test.

### D2. What the events contain — decided: B

The core's question is whether it ever has to deal with half-received JSON.

| Option                                                                                                                                                                                     | Pros                                                                                                                                        | Cons                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A. Raw fragments, including partial tool-call arguments                                                                                                                                    | Maximum information; the UI could show arguments as they arrive.                                                                            | Every consumer must reassemble and parse JSON; the core inherits a provider-level problem. |
| **B. Text streams as fragments; tool calls arrive complete** — a "tool call started" event (id, name) as soon as it begins, then a "tool call completed" event with fully parsed arguments | The adapter owns reassembly and parsing; the core only sees valid, whole tool calls. The "started" event still lets a UI react immediately. | A UI can't display arguments character by character.                                       |
| C. Both: fragments _and_ completed calls                                                                                                                                                   | Flexible.                                                                                                                                   | Two ways to consume the same information; more to test, and the duplication invites bugs.  |

**Decision: B.** It keeps the hardest parsing problem inside the adapter, where the contract tests can pin it down.

### D3. How errors travel — decided: A

| Option                                                                                                                                                                                                                                      | Pros                                                                                                                                                                                    | Cons                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **A. The stream throws a typed error** — consuming the stream either completes normally or throws a `ProviderError` with a _kind_ (e.g. `auth`, `rate_limit`, `overloaded`, `invalid_request`, `network`, `timeout`, `protocol`, `aborted`) | Works with D1-A: `try/catch` around `for await`. A consumer can't silently ignore it. The kind lets callers decide what to do (retry, tell the user, give up) without parsing messages. | Events already received before the failure have to be handled by the consumer (it has them; it just has to decide). |
| B. An `error` event inside the stream, then the stream ends                                                                                                                                                                                 | Everything is an event.                                                                                                                                                                 | Easy to forget to check for the error event; a stream that "completed" might have failed.                           |
| C. Result values (`{ ok: false, error }`)                                                                                                                                                                                                   | Explicit at the type level.                                                                                                                                                             | Awkward for a stream: every event or the whole stream has to be wrapped; un-idiomatic with `for await`.             |

**Decision: A**, with a fixed list of error kinds defined in this change.

### D4. What cancellation means for a provider — decided: A

Cancellation is requested through a standard `AbortSignal` passed with the request. The question is how the stream ends.

| Option                                                            | Pros                                                                                                                                            | Cons                                                                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **A. The stream throws a `ProviderError` of kind `aborted`**      | Same path as any other way a stream can end early (consistent with D3-A). Matches the platform convention: `fetch` rejects with an abort error. | Callers must treat `aborted` as a normal outcome, not a failure to report.                                  |
| B. The stream ends normally with a final "stopped: aborted" event | Abort isn't an error, so it isn't modelled as one.                                                                                              | A second way to end a stream; consumers must check the last event to know whether the response is complete. |

**Decision: A.** The contract guarantees that after the signal fires, no further events are emitted and the underlying connection is released.

_What the agent loop keeps from a partly received message is a Phase 2 decision; it doesn't affect this contract._

### D5. Where retries live — decided: B

Retrying after text has already streamed would duplicate output the user has seen, so the principle is: **retry only before the first event has been emitted.** The question is where that logic sits.

| Option                                                                                                                                                                                                             | Pros                                                                                                                                        | Cons                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A. Inside each adapter                                                                                                                                                                                             | Each adapter knows its own error codes.                                                                                                     | Written again in every adapter; easy to get subtly different.                      |
| **B. A wrapper that implements the same `ModelProvider` port** and wraps any other provider (the _decorator_ pattern): it retries retryable error kinds with backoff, only if no event has been passed through yet | Written once, works for every adapter, testable with FakeProvider. The adapters stay simple. A good, concrete example of why ports pay off. | One more piece; relies on error kinds (D3) being mapped correctly by each adapter. |
| C. No retries; the caller handles everything                                                                                                                                                                       | Simplest.                                                                                                                                   | Every caller reimplements it, or nobody does.                                      |

**Decision: B.** This change only defines which error kinds count as retryable; the wrapper itself is built in change 4.

_Update 2026-10-05: ADR-0007 defers the wrapper to "Later". The retryable classification stays in this change so the wrapper can use it when it's built._

### D6. Which content blocks exist in Phase 1 — decided: A

Text, tool calls and tool results are required. The question is reasoning ("thinking") output, which several models produce.

| Option                                                                                                                          | Pros                                                                                                                                                       | Cons                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Text, tool calls, tool results only**; unknown block types from a provider are skipped and counted, never crash the stream | Smallest model to get right first. Adding a variant later is cheap: the exhaustive `switch` checks make the compiler list every place that must handle it. | No reasoning output until it's added.                                                                                                       |
| B. Add thinking blocks now                                                                                                      | Ready for reasoning models from the start.                                                                                                                 | Anthropic requires thinking blocks to be sent back unchanged (with a signature) in tool-use loops, which adds rules before the basics work. |

**Decision: A**, with the "skip and count unknown blocks" rule written into the contract.

### D7. How the contract is enforced — accepted

A **shared contract test suite**: one set of tests, written against the port only, that checks the scenarios in `specs/model-provider`. FakeProvider runs it now; each real adapter must pass the same suite. This is what makes "every adapter satisfies the port" a checked fact rather than a hope.

The suite can't script a real provider's answers, so it doesn't take a provider directly. It takes a **factory**: given the name of a canonical situation ("a text-only answer", "one tool call", "fails before the first event", "fails after some text", …), the factory returns a provider that will produce that situation. FakeProvider's factory builds a script; a real adapter's factory replays a recorded response from `test/fixtures/` (ADR-0004).

Rules that only make sense for a real wire format — reassembling fragmented tool arguments, skipping unknown block types — can't be checked through the port with FakeProvider. They're verified in each adapter's own tests (changes 3–4).

_Handover (2026-10-05, from the review of this change):_ these `model-provider` scenarios are not tested by this change, and **must be explicit tasks in the Anthropic adapter change**, tested against recorded responses:

1. Fragments rebuild the text (exact concatenation of the provider's fragments)
2. No empty fragments (an empty provider fragment emits no event)
3. Output limit reached (stop reason `max_tokens`)
4. Unsupported block type (skipped, counted in `skippedBlocks`)
5. Failure before the first event (`auth`; removed from the contract suite by ADR-0007)
6. Malformed tool input (`protocol`)

The adapter must also run the shared suite, with its own `*.contract.test.ts` calling `describeModelProviderContract`.

### Conversation shape — follows ADR-0003, no choice needed

The canonical model follows Anthropic's block-based shape, as ADR-0003 decided. Concretely:

- **System instructions are part of the request, not a message.** Messages have only two roles: user and assistant. An OpenAI-style adapter turns the instructions into a system message when it builds its request.
- **Tool calls appear only in assistant messages; tool results only in user messages**, each result referring to its call by id. An OpenAI-style adapter maps results to its separate tool-role messages.

## Risks / Trade-offs

- [The contract is designed before any real adapter exists] → Expected to change when the second real adapter lands (ADR-0003). The contract test suite makes such changes safe: it shows what each adapter must update.
- [Error kinds are mapped wrongly by an adapter, e.g. a permanent error marked retryable] → The retry wrapper (D5) would then retry forever or pointlessly; each adapter's contract tests must cover its mapping, and retries are capped.
- [FakeProvider behaves more politely than real providers] → It must be scriptable to misbehave: fail before the first event, fail after some events, never finish until aborted.

## Open Questions

Deferrable, because none of them changes this contract:

- What the agent loop keeps from a partly received message after cancellation or failure (Phase 2).
- Backoff timing and the retry limit for the retry wrapper (change 4).
- Whether the core should check that a conversation is well formed (every tool call answered by a result) before sending it (Phase 2, when the loop builds conversations).
