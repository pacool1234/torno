import { describe, expect, it } from "vitest";
import type { TextBlock } from "./conversation.ts";

describe("Text blocks", () => {
  it("keeps text unchanged", () => {
    const textBlock: TextBlock = {
      type: "text",
      text: "Hello\n world!",
    };
    expect(textBlock.text).toBe("Hello\n world!");
  });
});
