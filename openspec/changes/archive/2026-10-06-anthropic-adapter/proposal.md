# Proposal

## Why

torno has a provider contract (`model-provider`) but no provider that talks to a real model. The week-1 plan (ADR-0007) needs one to run the agent loop against Claude Haiku and local models via Ollama. ADR-0003 decided the first real adapter speaks the Anthropic Messages protocol over raw HTTP, with a hand-written stream parser and no vendor SDK: that's where the protocol learning happens.

## What Changes

- An **Anthropic-protocol provider** (`src/adapters/providers/anthropic/`) implementing the `ModelProvider` port:
  - turns a canonical request into a Messages API request and sends it with `fetch`;
  - parses the server-sent event stream by hand;
  - translates Anthropic's events into canonical events: text, tool calls assembled from partial JSON, usage, stop reasons, skipped blocks such as `thinking`;
  - maps HTTP statuses, error events, network failures, cancellation and an idle timeout to provider errors;
  - releases the connection however the stream ends.
- **Configuration from environment variables**, validated with Zod: API key, base URL (Anthropic or Ollama), model.
- **Recorded fixtures** of real responses from Claude Haiku and Ollama, a script that records them, and tests that replay them through the adapter.
- The adapter **passes the shared contract suite** (`test/contract/`), and the six `model-provider` scenarios handed over by the previous change are tested here.
- A **smoke script** that streams one real response, with a tool call, from Ollama or Anthropic.
- **Zod** becomes the first runtime dependency (ADR-0002: untrusted input is validated at the edges).
- `openspec/config.yaml` stops telling AI assistants that only the human implements tasks (outdated since the rule change in `AGENTS.md`).

## Capabilities

### New Capabilities

- `anthropic-provider`: how torno talks to any server that speaks the Anthropic Messages protocol: the request it sends, how it reads the stream, how failures and cancellation surface, and how it's configured.

### Modified Capabilities

None. `model-provider` is implemented, not changed.

## Impact

- New code under `src/adapters/providers/anthropic/`, `test/fixtures/anthropic/`, `test/helpers/` and `scripts/`.
- New runtime dependency: `zod`.
- Network access only in the adapter, the recording script and the smoke script. Tests use recorded fixtures and never call a real API (ADR-0004).
- Recording fixtures costs a few cents of Claude Haiku usage, once.
