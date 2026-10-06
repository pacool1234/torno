# Proposal

## Why

torno can stream one response from a real model, but it can't act on it yet: nothing runs the tools the model asks for, sends the results back, and asks again. That loop is what turns a chat into an agent, and it's step 3 of the week-1 plan (ADR-0007). It lives in `src/core/` (ADR-0001), so it can be built and tested entirely with the scripted provider, before any real tool or REPL exists.

## What Changes

- An **agent loop** in `src/core/`. For one user message it:
  - sends the conversation to the `ModelProvider` and forwards what streams back as agent events;
  - when the model asks for tools, runs the calls one at a time, in order, and sends all of their results back in a single user message (ADR-0007);
  - repeats until the model ends its turn, or a limit, a failure or a cancellation stops it;
  - emits events and never prints (ADR-0001), so the REPL now and headless mode later render the same events.
- A **tool port**: what the loop needs from a tool (name, description, input schema, an `execute` that takes a signal). The real tools (`read_file`, `write_file`, `edit_file`, `bash`) are the next change; here, tests use scripted tools.
- An **approver port** (ADR-0005): before running a tool that needs approval, the loop asks; a denial goes back to the model as an error result instead of running the tool. The REPL's prompt and a headless policy are later implementations.
- **Limits**: a maximum number of model requests per user message, and the output limit per request passed to the provider. Hitting either ends the turn with a clear reason.
- **Cancellation**: the user's signal reaches the provider and the running tool. Whenever the loop stops, the conversation it returns is valid to send again: every tool call has a result, and nothing half-received is kept.
- **Failures**: a provider error ends the turn, with no retries (ADR-0007). A tool that fails, an unknown tool name or a denied call becomes an error result the model can react to.

## Capabilities

### New Capabilities

- `agent-loop`: how torno runs one user message to completion: the steps, the events it emits, tool execution and approval, limits, cancellation and failures, and the conversation it leaves behind.

### Modified Capabilities

None. `conversation-model` and `model-provider` are used as they are.

## Impact

- New code under `src/core/` (the loop, the agent events) and `src/core/ports/` (tool and approver ports), with tests using `ScriptedProvider`.
- No I/O, no new dependencies, no network: the whole change is testable offline.
- Not in this change: the real tools and path confinement, the REPL and its approval prompt, wiring in `src/main.ts` (all in the next change), retries, parallel tool calls and context management (deferred by ADR-0007).
- **Known limitation, found while writing this:** if a response hits the output limit in the middle of a tool call, the Anthropic adapter receives incomplete tool input and fails with `protocol`, not with stop reason `max_tokens`. The loop reports that failure as it is; a generous output limit makes it rare. Fixing it properly means changing when the adapter emits "tool call completed", which belongs in its own change if it shows up in practice.
