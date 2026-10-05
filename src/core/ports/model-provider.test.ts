import { describe, expect, expectTypeOf, it } from "vitest";
import {
  isRetryable,
  ProviderError,
  type ProviderErrorKind,
  type StopReason,
  type StreamEvent,
} from "./model-provider.ts";

const expectedRetryable: Record<ProviderErrorKind, boolean> = {
  rate_limit: true,
  overloaded: true,
  network: true,
  timeout: true,
  auth: false,
  invalid_request: false,
  protocol: false,
  aborted: false,
};

describe("Retryable error kinds", () => {
  it.each(Object.entries(expectedRetryable) as [ProviderErrorKind, boolean][])(
    "classifies %s as retryable: %s",
    (kind, retryable) => {
      expect(isRetryable(kind)).toBe(retryable);
    },
  );

  it("classifies overloaded as retryable", () => {
    expect(isRetryable("overloaded")).toBe(true);
  });

  it("classifies auth as not retryable", () => {
    expect(isRetryable("auth")).toBe(false);
  });
});

describe("ProviderError", () => {
  it("carries its kind and message", () => {
    const error = new ProviderError("rate_limit", "Too many requests");

    expect(error.kind).toBe("rate_limit");
    expect(error.message).toBe("Too many requests");
  });

  it("is an Error and a ProviderError, so `instanceof` checks work", () => {
    const error = new ProviderError("network", "Connection reset");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProviderError);
  });

  it("names itself, so stack traces and logs say what failed", () => {
    expect(new ProviderError("network", "Connection reset").name).toBe("ProviderError");
  });

  it("keeps the underlying cause", () => {
    const low = new SyntaxError("Unexpected end of JSON input");
    const error = new ProviderError("protocol", "Invalid tool input", { cause: low });

    expect(error.cause).toBe(low);
  });
});

describe("Stream contract types", () => {
  it("has exactly the four event types", () => {
    expectTypeOf<StreamEvent["type"]>().toEqualTypeOf<
      "text_delta" | "tool_call_started" | "tool_call_completed" | "response_completed"
    >();
  });

  it("has exactly the four stop reasons from the spec", () => {
    expectTypeOf<StopReason>().toEqualTypeOf<"end_turn" | "tool_use" | "max_tokens" | "other">();
  });

  it("has exactly the eight error kinds from the spec", () => {
    expectTypeOf<ProviderErrorKind>().toEqualTypeOf<
      | "auth"
      | "rate_limit"
      | "overloaded"
      | "invalid_request"
      | "network"
      | "timeout"
      | "protocol"
      | "aborted"
    >();
  });
});
