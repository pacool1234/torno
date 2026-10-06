# Design

> **Status: decided (2026-10-06).** D1–D4 were decided by Francisco; the alternatives stay below as the record.

## Context

- ADR-0001: the loop lives in `src/core/`, performs no I/O, emits events and never prints. Tools and approval reach it through ports.
- ADR-0005: every write, edit and `bash` call needs approval; the policy is a port (`Approver`), so the REPL asks a human and headless mode applies a policy.
- ADR-0007: tool calls run sequentially; all of a step's results go back in one user message; a step limit and `max_tokens`; no retries.
- `conversation-model`: messages alternate user/assistant; tool calls only in assistant messages, results only in user messages, each result referring to its call by id. Anthropic rejects a conversation where a tool call has no result in the next message.

## Terms

- **Turn:** everything torno does for one user message.
- **Step:** one model request inside a turn, plus running the tools it asked for. A turn has one or more steps.

## Decisions

### D1. Loop shape — decided: an async generator

```ts
function runTurn(
  config: AgentConfig,
  conversation: readonly Message[],
  prompt: string,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent>;
```

It yields agent events as they happen and always ends with exactly one `turn_ended` event, which carries the reason and the updated conversation. Expected outcomes (limits, provider failures, cancellation) are reasons, not exceptions; only bugs throw. The caller owns the conversation: it passes it in and keeps the one `turn_ended` returns. Same pattern as `ModelProvider.stream`: the consumer reads at its own pace, cancellation goes through the signal.

Alternatives: an `Agent` class holding the history (hidden mutable state; harder to test what's kept after a cancellation); callbacks or an event emitter (no backpressure; an error thrown in a listener lands inside the loop).

### D2. Conversation after an early stop — decided: keep finished steps, drop the step in progress

When a turn stops early (cancellation, provider failure):

- The user's message stays.
- Every finished step stays: its assistant message and its tool results.
- The step in progress is dropped if its response hadn't completed. Text already shown to the user is not kept.
- If the stop happens while tools run, each call that didn't run gets an error result ("Not run: the user cancelled."), so every call still has a result. The running tool receives the abort; whatever it returns or throws is recorded as its result.

This keeps one invariant, checked in every ending's tests: **the returned conversation is valid to send again.** Roles alternate starting with the user, and every tool call has exactly one result in the next message. A conversation may end with a user message (the turn stopped before the model answered); the next `runTurn` then appends its prompt to that message as a text block instead of adding a second user message.

Alternatives: roll back the whole turn (tools may already have changed files, and the model wouldn't know); keep the half-streamed text too (the model reads half a sentence as its own words, and a half-received tool call can't be kept anyway).

### D3. Approval — decided: in the loop

A tool declares `needsApproval`. Before running such a call, the loop asks the `Approver` (passing the call and the signal). A denial is not run; the model gets an error result ("The user denied this tool call.") and the loop continues with the next call. Calls that don't need approval (reads) run without asking. Approval stays visible in the events, which the week-2 trajectory will record.

Alternative: an approval wrapper around each tool, with the loop unaware (approval disappears from the events unless the wrapper emits them too).

### D4. Limits — decided: stop and report

- **Step limit** (`maxSteps`, default 25): when the model still wants tools after the last allowed step, the loop runs that step's tools, keeps their results, and ends with reason `step_limit`. The user can type "continue".
- **Output limit** (`maxOutputTokens`, default 8192, passed to the provider): a response with stop reason `max_tokens` ends the turn with reason `max_tokens`. Its text is kept; any tool calls in it are not run and get error results ("Not run: the response hit the output limit."), preserving the invariant.

Alternative: continue automatically after `max_tokens` and ask the user at the step limit (needs another approver method; spends tokens nobody asked for).

## Choices that follow, recorded for reference

- A step runs tools only when its stop reason is `tool_use`. `end_turn` and `other` end the turn with reason `completed`.
- An unknown tool name, or a tool that throws, becomes an error result and the loop continues: the model can correct itself, and the step limit bounds the retries.
- A response with no text and no tool calls adds nothing to the conversation (an assistant message can't be empty) and ends the turn.
- A provider error of kind `aborted`, or the signal being aborted at any check point, ends the turn as `cancelled`, not `failed`.
- Tools validate their own input (ADR-0002); the loop passes the parsed object through.
- Added by the change's review: tool results are capped at 30,000 characters, head and tail kept (ADR-0008), and `maxSteps` below 1 is rejected as a configuration bug.
