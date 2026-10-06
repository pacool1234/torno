import { describe, expect, it } from "vitest";
import type { ProviderRequest } from "../../../core/ports/model-provider.ts";
import { anthropicHeaders, messagesUrl, toAnthropicBody } from "./request.ts";

const signal = new AbortController().signal;

describe("toAnthropicBody", () => {
  it("maps a minimal request, without system or tools keys", () => {
    const request: ProviderRequest = {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      tools: [],
      maxOutputTokens: 100,
      signal,
    };

    expect(toAnthropicBody(request)).toStrictEqual({
      model: "claude-haiku-4-5",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    });
  });

  it("includes the system instructions when given", () => {
    const body = toAnthropicBody({
      model: "m",
      system: "You are torno.",
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      tools: [],
      maxOutputTokens: 100,
      signal,
    });

    expect(body.system).toBe("You are torno.");
  });

  it("maps tool calls and tool results to tool_use and tool_result blocks", () => {
    const body = toAnthropicBody({
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "Read a.ts" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_call", id: "call_1", toolName: "read_file", input: { path: "a.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolCallId: "call_1", isError: true, result: "File not found" },
          ],
        },
      ],
      tools: [],
      maxOutputTokens: 100,
      signal,
    });

    expect(body.messages).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "Read a.ts" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "File not found", is_error: true },
        ],
      },
    ]);
  });

  it("maps tool definitions to name, description and input_schema", () => {
    const inputSchema = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    };

    const body = toAnthropicBody({
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      tools: [{ name: "read_file", description: "Read a file", inputSchema }],
      maxOutputTokens: 100,
      signal,
    });

    expect(body.tools).toStrictEqual([
      { name: "read_file", description: "Read a file", input_schema: inputSchema },
    ]);
  });

  it("serializes with the same key order every time", () => {
    const request: ProviderRequest = {
      model: "m",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      tools: [{ name: "t", description: "d", inputSchema: {} }],
      maxOutputTokens: 1,
      signal,
    };

    expect(Object.keys(toAnthropicBody(request))).toEqual([
      "model",
      "max_tokens",
      "stream",
      "system",
      "tools",
      "messages",
    ]);
  });
});

describe("anthropicHeaders", () => {
  it("sends the API key, the protocol version and the content type", () => {
    expect(anthropicHeaders("sk-test")).toStrictEqual({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "sk-test",
    });
  });

  it("sends no x-api-key header when no key is configured", () => {
    expect(anthropicHeaders(undefined)).not.toHaveProperty("x-api-key");
  });
});

describe("messagesUrl", () => {
  it("appends /v1/messages to the base URL", () => {
    expect(messagesUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/messages");
  });

  it("doesn't double the slash when the base URL ends with one", () => {
    expect(messagesUrl("http://localhost:11434/")).toBe("http://localhost:11434/v1/messages");
  });

  it("keeps a path prefix in the base URL", () => {
    expect(messagesUrl("https://proxy.example/anthropic")).toBe(
      "https://proxy.example/anthropic/v1/messages",
    );
  });
});
