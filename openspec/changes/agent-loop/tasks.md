# Tasks

Each group is test-first and sized for one review. The AI stops after each group for the human's review.

## 1. Ports, events and test helpers

- [x] 1.1 Define the tool port (`src/core/ports/tool.ts`: definition, `needsApproval`, `execute(input, signal)` returning a result text and an error flag) and the approver port (`src/core/ports/approver.ts`: `approve(call, signal)` returning approve or deny)
- [x] 1.2 Define `AgentEvent` (text, tool call started, step completed, tool started, tool finished, turn ended with reason and conversation) and `AgentConfig` (provider, tools, approver, model, system, `maxOutputTokens`, `maxSteps`, with the defaults 8192 and 25), with type tests for the `turn_ended` union
- [x] 1.3 Write test helpers: a scripted tool (records calls and signals, returns or throws what it's told, can wait until aborted), a scripted approver, and `expectValidConversation` checking the invariant in design D2

## 2. A turn without tools

- [x] 2.1 Write tests: text-only answer, the request sent to the model, prompt appended to a trailing user message, empty response, `end_turn` and `other` both ending as `completed`; verify they fail
- [x] 2.2 Implement `runTurn` for steps without tools; verify the tests pass

## 3. Tools and approval

- [x] 3.1 Write tests: one call, two calls in order with one result message, second step sees the results, unknown tool, tool throws, read without asking, approved call, denied call; verify they fail
- [x] 3.2 Implement tool execution and approval; verify the tests pass

## 4. Limits and failures

- [ ] 4.1 Write tests: step limit, output limit (with and without tool calls in the cut response), provider failure in the second step, no retry; verify they fail
- [ ] 4.2 Implement them; verify the tests pass

## 5. Cancellation

- [ ] 5.1 Write tests: cancelled before the first request, while streaming, after a completed response before its tools, while a tool runs, at the approval prompt; each checks the conversation invariant; verify they fail
- [ ] 5.2 Implement them; verify the tests pass
- [ ] 5.3 Add the invariant test across every ending reason

## 6. Close the change

- [ ] 6.1 Run the full `REVIEW.md` review of the change and resolve its findings
- [ ] 6.2 Verify all scripts pass locally and CI is green on GitHub
- [ ] 6.3 Run `pnpm exec openspec validate agent-loop --strict`, archive the change, and format the archived specs
