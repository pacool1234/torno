import type { Message, NonEmptyArray, ToolCallBlock } from "../conversation.ts";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ProviderRequest = {
  model: string;
  system?: string;
  messages: NonEmptyArray<Message>;
  tools: readonly ToolDefinition[];
  maxOutputTokens: number;
  signal: AbortSignal;
};

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_started"; id: string; toolName: string }
  | { type: "tool_call_completed"; call: ToolCallBlock }
  | {
      type: "response_completed";
      stopReason: StopReason;
      usage: Usage;
      skippedBlocks: number;
    };

export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "network"
  | "timeout"
  | "protocol"
  | "aborted";

const RETRYABLE: Readonly<Record<ProviderErrorKind, boolean>> = {
  rate_limit: true,
  overloaded: true,
  network: true,
  timeout: true,
  auth: false,
  invalid_request: false,
  protocol: false,
  aborted: false,
};

export function isRetryable(kind: ProviderErrorKind): boolean {
  return RETRYABLE[kind];
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;

  constructor(kind: ProviderErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
    this.name = "ProviderError";
  }
}

export interface ModelProvider {
  stream(request: ProviderRequest): AsyncIterable<StreamEvent>;
}
