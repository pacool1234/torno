import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderRequest, ToolDefinition } from "../src/core/ports/model-provider.ts";
import {
  anthropicHeaders,
  messagesUrl,
  toAnthropicBody,
} from "../src/adapters/providers/anthropic/request.ts";

const FIXTURE_DIR = join(import.meta.dirname, "..", "test", "fixtures", "anthropic");

const ANTHROPIC_URL = "https://api.anthropic.com";
const OLLAMA_URL = "http://localhost:11434";
const HAIKU = "claude-haiku-4-5";
const GEMMA = "gemma4:e4b";

const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "Read a text file from the project and return its contents.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Path relative to the project root" } },
    required: ["path"],
  },
};

type Target = { baseUrl: string; apiKey: "env" | "none" | { fake: string } };

type Recording = {
  target: Target;
  request: Omit<ProviderRequest, "signal">;
  purpose: string;
};

const RECORDINGS = {
  "haiku-text": {
    purpose:
      "Text-only answer. Asks for non-ASCII text so chunk tests split multi-byte characters.",
    target: { baseUrl: ANTHROPIC_URL, apiKey: "env" },
    request: {
      model: HAIKU,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "In two short sentences, say what a lathe is in Spanish, then the same in Japanese.",
            },
          ],
        },
      ],
      tools: [],
      maxOutputTokens: 200,
    },
  },
  "haiku-tool-call": {
    purpose: "Text, then a tool call: the shape of every agent-loop step that uses a tool.",
    target: { baseUrl: ANTHROPIC_URL, apiKey: "env" },
    request: {
      model: HAIKU,
      system: "Before calling a tool, always say in one short sentence what you are about to do.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "What does README.md in this project say?" }],
        },
      ],
      tools: [readFileTool],
      maxOutputTokens: 300,
    },
  },
  "haiku-max-tokens": {
    purpose: "Answer cut off by max_tokens: stop reason max_tokens, partial text kept.",
    target: { baseUrl: ANTHROPIC_URL, apiKey: "env" },
    request: {
      model: HAIKU,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Write three paragraphs about the history of the lathe." },
          ],
        },
      ],
      tools: [],
      maxOutputTokens: 20,
    },
  },
  "haiku-401": {
    purpose: "Invalid API key: HTTP 401 with an authentication_error body.",
    target: { baseUrl: ANTHROPIC_URL, apiKey: { fake: "sk-ant-invalid-key-for-fixture" } },
    request: {
      model: HAIKU,
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      tools: [],
      maxOutputTokens: 20,
    },
  },
  "ollama-thinking-tool-call": {
    purpose: "Local model: a thinking block (unsupported, skipped) before a tool call.",
    target: { baseUrl: OLLAMA_URL, apiKey: "none" },
    request: {
      model: GEMMA,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "What does README.md in this project say?" }],
        },
      ],
      tools: [readFileTool],
      maxOutputTokens: 1000,
    },
  },
} satisfies Record<string, Recording>;

type RecordingName = keyof typeof RECORDINGS;

function isRecordingName(name: string): name is RecordingName {
  return Object.hasOwn(RECORDINGS, name);
}

function resolveKey(target: Target): string | undefined {
  if (target.apiKey === "none") {
    return undefined;
  }
  if (target.apiKey !== "env") {
    return target.apiKey.fake;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (key === undefined || key === "") {
    throw new Error("ANTHROPIC_API_KEY is not set (see .env.example)");
  }
  return key;
}

async function record(name: RecordingName): Promise<void> {
  const recording: Recording = RECORDINGS[name];
  const apiKey = resolveKey(recording.target);
  const body = toAnthropicBody({ ...recording.request, signal: AbortSignal.timeout(120_000) });

  const response = await fetch(messagesUrl(recording.target.baseUrl), {
    method: "POST",
    headers: anthropicHeaders(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = Buffer.from(await response.arrayBuffer());

  const metadata = {
    name,
    purpose: recording.purpose,
    recordedAt: new Date().toISOString(),
    baseUrl: recording.target.baseUrl,
    status: response.status,
    request: body,
  };
  const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;

  if (recording.target.apiKey === "env" && apiKey !== undefined) {
    if (raw.includes(apiKey) || metadataText.includes(apiKey)) {
      throw new Error(`Refusing to save ${name}: the response contains the API key`);
    }
  }

  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(join(FIXTURE_DIR, `${name}.sse`), raw);
  await writeFile(join(FIXTURE_DIR, `${name}.json`), metadataText);
  console.log(`${name}: HTTP ${response.status}, ${raw.length} bytes → test/fixtures/anthropic/`);
}

const names = process.argv.slice(2);
if (names.length === 0) {
  console.log(`Usage: pnpm record <name>...\nNames: ${Object.keys(RECORDINGS).join(", ")}`);
} else {
  for (const name of names) {
    if (!isRecordingName(name)) {
      console.error(`Unknown recording "${name}". Names: ${Object.keys(RECORDINGS).join(", ")}`);
      process.exitCode = 1;
      break;
    }
    await record(name);
  }
}
