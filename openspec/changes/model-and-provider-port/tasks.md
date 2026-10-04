# Tasks

> Since 2026-10-05 the AI implements the tasks with thorough comments, and the human reviews each group (AGENTS.md). Within each group, tests come before the code they cover. Request a review (REVIEW.md) at the end of each group: each group is sized to stay under ~300 lines of change.

## 1. Conversation model (`src/core/`)

- [x] 1.1 Write type-level tests for the `conversation-model` scenarios (e.g. with Vitest's `expectTypeOf`, plus `// @ts-expect-error` lines for combinations that must not compile, such as a tool call in a user message) and verify `pnpm typecheck` fails before the types exist
- [x] 1.2 Define the message, role and content block types as discriminated unions, and verify `pnpm typecheck` and `pnpm test` pass, including every `@ts-expect-error` line
- [x] 1.3 Request review of group 1

## 2. Port, events and errors (`src/core/ports/`)

- [ ] 2.1 Write unit tests for the retryable classification (every error kind, both outcomes) and verify they fail
- [ ] 2.2 Define the request, tool definition, stream event, stop reason and usage types, the error kinds and the provider error, and the `ModelProvider` port; implement the retryable classification; verify the tests from 2.1 pass
- [ ] 2.3 Verify ESLint's import rule holds: nothing under `src/core/` imports from `src/adapters/` (`pnpm lint` passes)
- [ ] 2.4 Request review of group 2

## 3. Scripted provider (`src/adapters/providers/fake/`)

- [ ] 3.1 Write tests for the two scripted-provider scenarios (failure after events; waiting for cancellation) and verify they fail
- [ ] 3.2 Design the script format in words in a short comment block or design note, then implement the scripted provider; verify the tests from 3.1 pass
- [ ] 3.3 Make the scripted provider report when it has released its resources, so early exit can be observed; verify with a test that breaks out after the first event
- [ ] 3.4 Request review of group 3

## 4. Contract test suite (`test/contract/`)

- [ ] 4.1 Define the list of canonical situations the suite needs (text-only answer, text then tool call, failure before the first event, failure after some text, never finishing until cancelled) and the factory signature that turns a situation into a provider (design.md, D7)
- [ ] 4.2 Write the suite: one test per `model-provider` scenario that can be expressed through the port; verify it runs against the scripted provider's factory and passes
- [ ] 4.3 Prove the suite can fail: temporarily break the scripted provider (e.g. emit an event after completion) and verify at least one contract test fails; then revert
- [ ] 4.4 Request review of group 4

## 5. Close the change

- [ ] 5.1 Verify all five scripts pass locally and CI is green on GitHub
- [ ] 5.2 Run `pnpm exec openspec validate model-and-provider-port --strict` and fix anything it reports
- [ ] 5.3 Archive the change with `pnpm exec openspec archive model-and-provider-port`, and verify `openspec/specs/` now contains `conversation-model` and `model-provider`
