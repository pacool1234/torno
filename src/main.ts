// The composition root (ADR-0001): the only file that knows every adapter and
// connects them to the core. Everything else depends on ports; this file picks
// the real implementations: the Anthropic provider, the four tools sharing
// one workspace and read log, and the REPL as the approver.

import { AnthropicProvider } from "./adapters/providers/anthropic/anthropic-provider.ts";
import { Session } from "./adapters/repl/session.ts";
import { createBash } from "./adapters/tools/bash.ts";
import { createEditFile, createWriteFile } from "./adapters/tools/change-file.ts";
import { createReadFile } from "./adapters/tools/read-file.ts";
import { ReadLog } from "./adapters/tools/read-log.ts";
import { createSummarizer } from "./adapters/tools/summarize.ts";
import { Workspace } from "./adapters/tools/workspace.ts";
import { type Config, loadConfig } from "./config.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_STEPS } from "./core/agent.ts";

// A configuration mistake is the user's to fix, not a bug: print the message
// (which names the variable) and exit with status 1, without a stack trace
// (spec "Bad configuration").
let config: Config;
try {
  config = loadConfig(process.env);
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// The project is the directory torno was started in.
const workspace = await Workspace.open(process.cwd());
// One read log for the session, shared by the three file tools: a read by
// read_file is what allows a later edit_file (design D3).
const readLog = new ReadLog();

const session = new Session({
  input: process.stdin,
  output: process.stdout,
  // A real terminal gets line editing and Ctrl-C handling from readline; a
  // pipe (`echo task | pnpm start`) gets plain line reading.
  terminal: process.stdin.isTTY,
  summarize: createSummarizer(workspace),
  agent: {
    provider: new AnthropicProvider({
      baseUrl: config.baseUrl,
      // Spread so that "no key" stays an absent property (see Config).
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    }),
    tools: [
      createReadFile(workspace, readLog),
      createWriteFile(workspace, readLog),
      createEditFile(workspace, readLog),
      createBash(workspace),
    ],
    model: config.model,
    system: systemPrompt(workspace.root),
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    maxSteps: DEFAULT_MAX_STEPS,
  },
});

// The key is never printed, only where requests go.
console.log(`torno · ${config.model} at ${config.baseUrl}`);
console.log("Ctrl-C cancels the current answer · Ctrl-D or exit quits\n");
await session.run();

// Short on purpose: the tool descriptions already explain each tool, and every
// line here is sent (and paid for) with every request.
function systemPrompt(root: string): string {
  return [
    "You are torno, a coding agent working in a local project.",
    `The project root is ${root}. Paths are relative to it.`,
    "Read a file before changing it, and prefer edit_file for small changes.",
    "Every write, edit and command needs the user's approval; if they deny one, ask what they want instead.",
    "Keep answers short.",
  ].join("\n");
}
