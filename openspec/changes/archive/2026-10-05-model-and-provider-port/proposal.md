# Proposal

## Why

Every later part of torno — the agent loop, every provider adapter, the eval harness — depends on two things that don't exist yet: a provider-independent way to represent a conversation, and a contract for "send a conversation to a model and stream back what it produces". If these are shaped by the first adapter instead of designed on purpose, every future provider inherits that adapter's quirks (ADR-0003).

## What Changes

- A **canonical conversation model**: messages and the content blocks they contain (text, tool calls, tool results), independent of any vendor's format.
- A **canonical stream of events** that a model response produces: text arriving, a tool call starting and completing, the response finishing with a stop reason and token usage.
- The **`ModelProvider` port** (ADR-0001): the contract every provider adapter must satisfy, including how errors and cancellation behave.
- A **FakeProvider** that replays scripted responses and satisfies the same contract, so the contract is executable and testable from day one.
- A **reusable contract test suite** that any `ModelProvider` implementation can be run against. FakeProvider passes it now; the Anthropic adapter (change 4) must pass the same suite.

Proposed change to the plan: this merges the originally separate change 2 (FakeProvider) into this one. A port with no implementation can't be tested, so its specs would have no executable scenarios.

## Capabilities

### New Capabilities

- `conversation-model`: how a conversation is represented inside torno — messages, roles, and content blocks — independently of any provider.
- `model-provider`: the contract for streaming one model response: the request it accepts, the events it emits and in what order, how it finishes, fails, and is cancelled.

### Modified Capabilities

None.

## Impact

- New code only under `src/core/` (model types, port) and `src/adapters/providers/fake/`. No network, no I/O.
- No new runtime dependencies.
- Changes 3–5 (Anthropic parser, adapter, telemetry) build on this contract. The contract is expected to change when the second real adapter (OpenAI-compatible, Phase 2) lands; that's its purpose, not a failure of this design (ADR-0003).
