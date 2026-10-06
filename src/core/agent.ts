import type { Message, ToolCallBlock, ToolResultBlock } from "./conversation.ts";
import type { Approver } from "./ports/approver.ts";
import type { ModelProvider, ProviderError, StopReason, Usage } from "./ports/model-provider.ts";
import type { Tool } from "./ports/tool.ts";

export const DEFAULT_MAX_STEPS = 25;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export type AgentConfig = {
  provider: ModelProvider;
  tools: readonly Tool[];
  approver: Approver;
  model: string;
  system?: string;
  maxOutputTokens: number;
  maxSteps: number;
};

export type TurnEndReason = "completed" | "step_limit" | "max_tokens" | "cancelled" | "failed";

export type TurnEnded =
  | {
      type: "turn_ended";
      reason: Exclude<TurnEndReason, "failed">;
      conversation: readonly Message[];
    }
  | {
      type: "turn_ended";
      reason: "failed";
      error: ProviderError;
      conversation: readonly Message[];
    };

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_started"; id: string; toolName: string }
  | {
      type: "step_completed";
      step: number;
      stopReason: StopReason;
      usage: Usage;
      skippedBlocks: number;
    }
  | { type: "tool_started"; call: ToolCallBlock }
  | { type: "tool_finished"; call: ToolCallBlock; result: ToolResultBlock }
  | TurnEnded;
