import { describe, expectTypeOf, it } from "vitest";
import type { AgentEvent, TurnEnded } from "./agent.ts";
import type { ProviderError } from "./ports/model-provider.ts";

describe("TurnEnded", () => {
  it("carries an error exactly when the reason is failed", () => {
    type Failed = Extract<TurnEnded, { reason: "failed" }>;
    type NotFailed = Exclude<TurnEnded, { reason: "failed" }>;

    expectTypeOf<Failed["error"]>().toEqualTypeOf<ProviderError>();
    expectTypeOf<NotFailed>().not.toHaveProperty("error");
  });

  it("has exactly the reasons in the spec", () => {
    expectTypeOf<TurnEnded["reason"]>().toEqualTypeOf<
      "completed" | "step_limit" | "max_tokens" | "cancelled" | "failed"
    >();
  });

  it("narrows on the reason, so a failed turn's error needs no undefined check", () => {
    const summarize = (ended: TurnEnded): string =>
      ended.reason === "failed" ? ended.error.kind : ended.reason;

    expectTypeOf(summarize).returns.toEqualTypeOf<string>();
  });
});

describe("AgentEvent", () => {
  it("has exactly these event types", () => {
    expectTypeOf<AgentEvent["type"]>().toEqualTypeOf<
      | "text_delta"
      | "tool_call_started"
      | "step_completed"
      | "tool_started"
      | "tool_finished"
      | "turn_ended"
    >();
  });
});
