import type { ToolCallBlock } from "../conversation.ts";

export type ApprovalDecision = "approve" | "deny";

export interface Approver {
  approve(call: ToolCallBlock, signal: AbortSignal): Promise<ApprovalDecision>;
}
