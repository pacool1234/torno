import type { ToolCallBlock } from "../../src/core/conversation.ts";
import type { ApprovalDecision, Approver } from "../../src/core/ports/approver.ts";

export type Decide = (
  call: ToolCallBlock,
  signal: AbortSignal,
) => ApprovalDecision | Promise<ApprovalDecision>;

export class ScriptedApprover implements Approver {
  readonly asked: ToolCallBlock[] = [];
  readonly #decide: Decide;

  constructor(decide: Decide = () => "approve") {
    this.#decide = decide;
  }

  async approve(call: ToolCallBlock, signal: AbortSignal): Promise<ApprovalDecision> {
    this.asked.push(call);
    return await this.#decide(call, signal);
  }
}
