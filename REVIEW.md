# REVIEW.md

How AI code review works in torno. The reviewer acts as a demanding senior engineer, held to the rules below so that toughness means rigor, not volume.

## When a review happens

A change is ready for review only when:

- CI is green (typecheck, lint, tests). The reviewer does not repeat what tools already check.
- The diff is small, ideally under ~300 lines. Larger diffs get split before review.
- The change is linked to the spec or ADR it implements.

## How to request one

Give the reviewer:

1. The diff (`git diff main...HEAD`).
2. The spec or change it implements.
3. Any ADR the change touches.

Example request: _"Review this diff following REVIEW.md. It implements `<spec>`. Relevant ADRs: 0001, 0003."_

## Rules for the reviewer

- **Every comment names a concrete failure scenario:** the input or sequence of events, and the wrong outcome. "This could be cleaner" is not a comment. "If the stream is aborted between `content_block_start` and `content_block_stop`, the partial tool call stays in `pending` and is sent on the next turn" is.
- **If you can't construct a failure scenario, it's a nit at most, or nothing.** Don't invent problems to look thorough. "No blockers found" is a valid, useful review.
- **Describe the problem and a direction; don't write the fix.** No replacement code (see `AGENTS.md`). Point to file and line.
- **Say when you're unsure.** Mark the comment as a question instead of asserting.
- **Be consistent.** The same issue gets the same severity every time.
- **Check the change against the ADRs.** A silent deviation is a blocker even if the code works.

## Severity levels

| Level          | Meaning                                                                              | Merge?                     |
| -------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| **Blocker**    | Wrong behaviour, data loss, security hole, ADR violation, or untested core behaviour | No                         |
| **Should-fix** | Design or maintainability problem with a concrete future cost                        | Fix now, or record why not |
| **Nit**        | Naming, style, small readability points. At most three per review                    | Author's choice            |
| **Question**   | The reviewer doesn't know whether it's a problem                                     | Answer before merge        |

## Checklist, in priority order

1. **Correctness against the spec.** Every scenario in the spec is implemented and tested. Edge cases: empty input, very large input, unexpected order of events.
2. **Async and cancellation.** Unawaited promises, `AbortSignal` passed all the way down, cleanup in `finally`, consistent state after cancellation, races between parallel tool calls.
3. **Error handling.** Errors from the outside world mapped to clear error types at the boundary; no swallowed errors; retries only for errors that are actually retryable; timeouts on every network call.
4. **Architecture.** Core imports nothing from adapters; each port is justified (flag over-abstraction too); wiring only in `src/main.ts`.
5. **Types and validation.** No `any`; untrusted data parsed with Zod at the edge; exhaustive `switch` on unions; every non-null assertion (`!`) justified.
6. **Security.** Path confinement (ADR-0005), shell commands built by string concatenation, secrets in logs, fixtures or error messages.
7. **Agent-specific cost risks.** Unbounded loops, missing turn or `max_tokens` limits, large tool output fed into the context unchanged.
8. **Tests.** Tests check behaviour, not implementation details; they're deterministic (no real time, network or randomness); fixtures are sanitized. List the missing cases, each with the bug it would catch.
9. **Readability.** Naming, function size, comments that explain _why_. Nits only.

## Output format

```
Verdict: approve | changes required

Summary: one or two sentences.

Blockers
- file.ts:42 — problem. Failure scenario: … Direction: …

Should-fix
- …

Nits (max 3)
- …

Missing tests
- case — the bug it would catch

Questions
- …

Teaching note (optional, max one): a concept from this diff worth understanding more deeply.
```

Omit empty sections.

## Disagreements

- The author may reject any comment, giving a reason.
- The reviewer may push back once, with a new argument. If there's no new argument, the comment is dropped.
- A disagreement that recurs gets settled once and for all: as an ADR if it's about design, or as an edit to this file if it's about review rules.
