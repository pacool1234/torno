export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolCallBlock = {
  type: "tool_call";
  id: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type ToolResultBlock = {
  type: "tool_result";
  toolCallId: string;
  toolCallFailed: boolean;
  result: string;
};

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;
export type UserContentBlock = TextBlock | ToolResultBlock;
export type AssistantContentBlock = TextBlock | ToolCallBlock;

type NonEmptyArray<T> = readonly [T, ...T[]];

export type UserMessage = {
  role: "user";
  content: NonEmptyArray<UserContentBlock>;
};

export type AssistantMessage = {
  role: "assistant";
  content: NonEmptyArray<AssistantContentBlock>;
};

export type Message = UserMessage | AssistantMessage;
export type Role = Message["role"];
