import type { StreamEvent } from "../../../core/ports/model-provider.ts";
import { describeModelProviderContract } from "../../../../test/contract/model-provider-contract.ts";
import type { ContractSituation } from "../../../../test/contract/model-provider-contract.ts";
import { type Script, ScriptedProvider } from "./scripted-provider.ts";

const text = (fragment: string): StreamEvent => ({ type: "text_delta", text: fragment });

const completed = (stopReason: "end_turn" | "tool_use"): StreamEvent => ({
  type: "response_completed",
  stopReason,
  usage: { inputTokens: 12, outputTokens: 5 },
  skippedBlocks: 0,
});

const scripts: Record<ContractSituation, Script> = {
  text_only: { events: [text("Hi"), text(" there"), completed("end_turn")] },
  text_then_tool_call: {
    events: [
      text("Let me check."),
      { type: "tool_call_started", id: "call_1", toolName: "read_file" },
      {
        type: "tool_call_completed",
        call: { type: "tool_call", id: "call_1", toolName: "read_file", input: { path: "a.ts" } },
      },
      completed("tool_use"),
    ],
  },
  failure_after_text: {
    events: [text("Hel")],
    ending: { type: "fail", kind: "network" },
  },
  never_finishes: {
    events: [text("Hel"), text("lo")],
    ending: { type: "hang" },
  },
};

describeModelProviderContract("ScriptedProvider", (situation) => {
  const provider = new ScriptedProvider([scripts[situation]]);
  return { provider, openResources: () => provider.openStreams };
});
