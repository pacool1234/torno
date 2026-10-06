import { AnthropicProvider } from "../src/adapters/providers/anthropic/anthropic-provider.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { ProviderError, type StreamEvent } from "../src/core/ports/model-provider.ts";

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const provider = new AnthropicProvider({
  baseUrl: config.baseUrl,
  ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
});

const prompt =
  process.argv[2] ?? "What does README.md in this project say? Use the tool to find out.";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());

console.log(
  `→ ${config.model} at ${config.baseUrl} (${config.apiKey === undefined ? "no API key" : "API key set"})`,
);

function show(event: StreamEvent): void {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      return;
    case "tool_call_started":
      console.log(`\n[tool call started] ${event.toolName} (${event.id})`);
      return;
    case "tool_call_completed":
      console.log(`[tool call completed] ${JSON.stringify(event.call.input)}`);
      return;
    case "response_completed":
      console.log(`\n[completed] ${JSON.stringify(event)}`);
      return;
    default: {
      const unhandled: never = event;
      throw new Error(`Unhandled event: ${JSON.stringify(unhandled)}`);
    }
  }
}

try {
  for await (const event of provider.stream({
    model: config.model,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    tools: [
      {
        name: "read_file",
        description: "Read a text file from the project and return its contents.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to the project root" },
          },
          required: ["path"],
        },
      },
    ],
    maxOutputTokens: 1000,
    signal: controller.signal,
  })) {
    show(event);
  }
} catch (error: unknown) {
  if (error instanceof ProviderError) {
    console.error(`\n[failed] ${error.kind}: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
