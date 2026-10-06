# Tasks

> The AI implements each group with thorough comments; the human reviews each group before the next starts (AGENTS.md, ADR-0007). Within each group, tests come before the code they cover, and every new test is shown to fail when the code it covers is broken. Each group stays under ~300 lines of change.

The six `model-provider` scenarios handed over by `model-and-provider-port` (its design.md, D7) are covered here:

| Handed-over scenario           | Tested in |
| ------------------------------ | --------- |
| Fragments rebuild the text     | 3.1, 5.3  |
| No empty fragments             | 3.1       |
| Output limit reached           | 3.1, 5.3  |
| Unsupported block type         | 3.1, 5.3  |
| Failure before the first event | 4.2, 5.3  |
| Malformed tool input           | 3.1       |

## 1. Setup and event-stream parser (`src/adapters/providers/anthropic/`)

- [x] 1.1 Add `zod` as a runtime dependency; update `openspec/config.yaml` so its context matches the AI-implements rule in `AGENTS.md`
- [x] 1.2 Write tests for the event-stream parser: `event` and `data` fields, several `data` lines, comment lines, LF and CRLF, and the same events whether the body arrives whole, one byte at a time, or split inside lines and multi-byte characters; verify they fail
- [x] 1.3 Implement the parser (bytes in, `{ event, data }` records out, no I/O); verify the tests pass
- [x] 1.4 Request review of group 1

## 2. Request mapping and wire schemas

- [x] 2.1 Write tests for the spec's request scenarios (minimal request, tool call and tool result mapping, tool definitions, no API key) and for the headers; verify they fail
- [x] 2.2 Implement the canonical-to-Anthropic request mapping and headers; define Zod schemas for the wire events the translator uses
- [x] 2.3 Request review of group 2

## 3. Stream translation (Anthropic events → canonical events)

- [x] 3.1 Write tests with hand-written event sequences for: text fragments and empty deltas; tool input split across fragments, empty input as `{}`, malformed input as `protocol`; skipped `thinking` blocks counted; stop reasons, including `stop_sequence` → `other`; usage with and without cache fields, and later counts replacing earlier ones; `ping` and unknown events ignored; malformed event data as `protocol`; `error` events mapped by type; a stream that ends before `message_stop` as `network`; nothing read after `message_stop`. Verify they fail
- [x] 3.2 Implement the translator as a pure function over parsed events; verify the tests pass
- [x] 3.3 Request review of group 3

## 4. HTTP provider

- [ ] 4.1 Write a fake `fetch` helper in `test/helpers/`: answers with a given status and body, streams the body in chosen chunks, can cut the body short or hold it open, and counts bodies still open
- [ ] 4.2 Write tests for: every status mapping in the spec, with the server's message in the error; connection failure and body read failure as `network`; a signal fired before the request and mid-stream as `aborted`; the idle timeout while waiting for headers and between chunks, and its reset by data (fake timers, no real waiting); the body cancelled and the timer cleared on every way the stream can end. Verify they fail
- [ ] 4.3 Implement `AnthropicProvider` (base URL, optional API key, injectable `fetch`, idle timeout); verify the tests pass
- [ ] 4.4 Request review of group 4

## 5. Fixtures and the contract suite

- [ ] 5.1 Write `scripts/record-fixture.ts` with named requests: from Claude Haiku a text-only answer, text then a tool call, a response cut by `max_tokens`, and a 401 from an invalid key; from Ollama a response with a `thinking` block before a tool call. It saves the body and a metadata file, never headers
- [ ] 5.2 Ask the human before recording (it spends a few cents), record the fixtures, and check that no fixture contains an API key or private data
- [ ] 5.3 Write fixture tests: each recording gives the same events whole and in awkward chunks; the `max_tokens`, `thinking` and 401 recordings produce the handed-over scenarios' results; text fragments rebuild the recorded text
- [ ] 5.4 Write `anthropic-provider.contract.test.ts`: a factory that replays the recordings through the fake `fetch` (cut short for "failure after text", held open for "never finishes") and runs the shared contract suite; verify it passes, and that it fails when the provider is broken
- [ ] 5.5 Request review of group 5

## 6. Configuration and smoke script

- [ ] 6.1 Write tests for the configuration loader's scenarios (defaults, Ollama, invalid base URL without leaking the key); verify they fail
- [ ] 6.2 Implement the loader with Zod; verify the tests pass
- [ ] 6.3 Write `scripts/smoke-provider.ts` (`pnpm smoke`): loads the configuration, streams one response with a tool available, and prints each event; run it against Ollama and against Claude Haiku
- [ ] 6.4 Request review of group 6

## 7. Close the change

- [ ] 7.1 Run the full `REVIEW.md` review of the change and resolve its findings
- [ ] 7.2 Verify all scripts pass locally and CI is green on GitHub
- [ ] 7.3 Run `pnpm exec openspec validate anthropic-adapter --strict`, archive the change, and format the archived specs
