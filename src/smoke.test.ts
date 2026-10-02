import { describe, expect, it } from "vitest";
import { add } from "./math.ts";

describe("Smoke Test", () => {
  it("should pass basic math check", () => {
    expect(add(1, 1)).toBe(2);
  });
});
