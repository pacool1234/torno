# Design

> **Status: decided (2026-10-05).** D1–D4 were decided by Francisco; the alternatives stay below as the record. Per ADR-0007 this file only records real decisions.

## Context

- ADR-0003: Anthropic protocol over raw HTTP, `fetch` plus a hand-written event-stream parser; developed against Ollama, validated against recorded Claude responses.
- ADR-0002: Zod validates untrusted input at the edges. Every event from the network is untrusted.
- ADR-0004: no real API calls in ordinary test runs; recorded fixtures replayed through the adapter.
- `model-provider` spec and the shared contract suite define the behaviour the adapter must have.

## Decisions

### D1. Configuration — decided: environment variables, read by the composition root

`src/main.ts` (and the dev scripts) read `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`) and `TORNO_MODEL` (default `claude-haiku-4-5`), validate them with Zod, and pass plain values to the adapter's constructor. The adapter never reads the environment, so tests construct it with explicit values. Switching to Ollama is a change in `.env`.

Alternatives: CLI flags (needs argument parsing now; long command lines); a config file (planned for later; more to build for three settings).

### D2. Testing HTTP — decided: inject `fetch`

The adapter takes a `fetch` function (default: the global `fetch`). Tests pass a fake that returns a `Response` whose body streams a recorded fixture, split into chunks at awkward places (inside an event, inside a multi-byte character) to exercise the parser. The fake also counts open bodies, which gives the contract suite its `openResources` probe, and can cut the stream short or hold it open to produce the "failure after text" and "never finishes" situations.

Alternative: a local `node:http` server serving fixtures. Exercises real sockets, but it's slower, needs ports, and makes chunk boundaries and resource counting hard to control.

### D3. Fixtures — decided: a recording script

`scripts/record-fixture.ts <name>` sends a named, fixed request (defined in the script) to Anthropic or Ollama and saves the raw response body as `test/fixtures/anthropic/<name>.sse`, plus `<name>.json` with the HTTP status, the request body and where it was recorded. Headers are never saved, so the API key can't end up in a fixture.

Alternatives: documented curl commands (manual, and requests aren't versioned with fixtures); opt-in live tests that save what they receive (mixes live calls and recording).

### D4. Timeout — decided: idle timeout

The request fails with `timeout` if no bytes arrive for `idleTimeoutMs` (default 60 000), both while waiting for the response headers and between chunks of the body. Anthropic sends `ping` events while it works, so a healthy stream never goes idle that long; a stalled connection does. A long answer that keeps streaming is never cut off.

Alternatives: a total timeout (too short for long answers or too long to catch a stall); both (two timers and more tests for little gain this week).

## Choices that follow from the spec, recorded for reference

- **Status mapping for 5xx:** 500, 502, 503 and 504 map to `overloaded`, like 529: all mean "the provider can't serve this right now, try later". The port has no separate server-error kind, and `overloaded` has the right retry classification.
- **402 (billing)** maps to `auth`: an account problem that retrying won't fix.
- **Tool input `""`:** Anthropic sends an empty `partial_json` for a tool called without arguments; it's parsed as `{}`.
- **Thinking blocks are skipped, not sent back.** torno doesn't request thinking from Anthropic. Ollama's gemma emits thinking blocks unasked; dropping them from the history is accepted for local models.
