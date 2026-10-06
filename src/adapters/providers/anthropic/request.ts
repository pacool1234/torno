import type { ContentBlock, Message } from "../../../core/conversation.ts";
import type { ProviderRequest, ToolDefinition } from "../../../core/ports/model-provider.ts";

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
};

type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  stream: true;
  system?: string;
  tools?: AnthropicTool[];
  messages: AnthropicMessage[];
};

const ANTHROPIC_VERSION = "2023-06-01";

export function toAnthropicBody(request: ProviderRequest): AnthropicRequestBody {
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    stream: true,
    ...(request.system === undefined ? {} : { system: request.system }),
    ...(request.tools.length === 0 ? {} : { tools: request.tools.map(toAnthropicTool) }),
    messages: request.messages.map(toAnthropicMessage),
  };
}

function toAnthropicTool(tool: ToolDefinition): AnthropicTool {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
}

function toAnthropicMessage(message: Message): AnthropicMessage {
  return { role: message.role, content: message.content.map(toAnthropicBlock) };
}

function toAnthropicBlock(block: ContentBlock): AnthropicContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_call":
      return { type: "tool_use", id: block.id, name: block.toolName, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolCallId,
        content: block.result,
        is_error: block.isError,
      };
    default: {
      const unhandled: never = block;
      throw new Error(`Unhandled content block: ${JSON.stringify(unhandled)}`);
    }
  }
}

export function anthropicHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    ...(apiKey === undefined ? {} : { "x-api-key": apiKey }),
  };
}

export function messagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
}
