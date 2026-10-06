// The approver the REPL provides (ADR-0005 level 1, design D4): shows what a
// call will do and asks y/N. It implements the core's Approver port, so the
// loop doesn't know a human is answering.

import type { ToolCallBlock } from "../../core/conversation.ts";
import type { ApprovalDecision, Approver } from "../../core/ports/approver.ts";
import { visible } from "./render.ts";

export type PromptApproverDeps = {
  // Built by the tools module (it needs the file system); see summarize.ts.
  summarize: (call: ToolCallBlock) => Promise<string>;
  // Shows the question and resolves with the typed answer; rejects when the
  // signal aborts. The REPL passes readline's question() here.
  ask: (question: string, signal: AbortSignal) => Promise<string>;
};

// Only an explicit yes approves (spec "Default is no"): an empty answer or a
// stray key press must never run a command. Surrounding spaces are ignored,
// case doesn't matter.
const YES = /^(y|yes)$/i;

export class PromptApprover implements Approver {
  readonly #deps: PromptApproverDeps;

  constructor(deps: PromptApproverDeps) {
    this.#deps = deps;
  }

  async approve(call: ToolCallBlock, signal: AbortSignal): Promise<ApprovalDecision> {
    const summary = await this.#deps.summarize(call);
    // "[y/N]": the capital N is the usual way to show the default.
    // A rejection (Ctrl-C at the question) propagates on purpose: the loop
    // sees an aborted signal and ends the turn as cancelled.
    // visible(): the summary carries the model's raw input, and a control
    // character in it could make the question show a different command
    // from the one that will run (spec "A command that hides itself").
    const answer = await this.#deps.ask(`${visible(summary)}\nAllow? [y/N] `, signal);
    return YES.test(answer.trim()) ? "approve" : "deny";
  }
}
