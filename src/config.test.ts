import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const KEY = "sk-ant-test-1111111111";

describe("loadConfig", () => {
  it("uses Anthropic and Claude Haiku, with no key, when nothing is set", () => {
    expect(loadConfig({})).toEqual({
      baseUrl: "https://api.anthropic.com",
      model: "claude-haiku-4-5",
    });
  });

  it("points at Ollama when the base URL and model say so", () => {
    expect(
      loadConfig({ ANTHROPIC_BASE_URL: "http://localhost:11434", TORNO_MODEL: "gemma4:e4b" }),
    ).toEqual({ baseUrl: "http://localhost:11434", model: "gemma4:e4b" });
  });

  it("passes the API key through when it's set", () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: KEY })).toMatchObject({ apiKey: KEY });
  });

  it("treats empty values as not set", () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "", TORNO_MODEL: "" })).toEqual({
      baseUrl: "https://api.anthropic.com",
      model: "claude-haiku-4-5",
    });
  });

  it.each(["not a url", "ftp://example.com", "localhost:11434"])(
    "rejects the base URL %j, naming the variable and never the key",
    (baseUrl) => {
      let message = "";
      try {
        loadConfig({ ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: KEY });
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain("ANTHROPIC_BASE_URL");
      expect(message).not.toContain(KEY);
    },
  );

  it("ignores unrelated variables", () => {
    expect(loadConfig({ PATH: "/usr/bin", HOME: "/home/someone" })).toEqual({
      baseUrl: "https://api.anthropic.com",
      model: "claude-haiku-4-5",
    });
  });
});
