import type { ToolDefinition } from "../../src/core/ports/model-provider.ts";
import type { Tool, ToolOutput } from "../../src/core/ports/tool.ts";

export type ToolRun = (
  input: Record<string, unknown>,
  signal: AbortSignal,
) => ToolOutput | Promise<ToolOutput>;

export type RecordedToolCall = {
  input: Record<string, unknown>;
  signal: AbortSignal;
};

export class ScriptedTool implements Tool {
  readonly definition: ToolDefinition;
  readonly needsApproval: boolean;
  readonly calls: RecordedToolCall[] = [];

  readonly #run: ToolRun;
  readonly #log: string[] | undefined;

  constructor(
    name: string,
    options: { needsApproval?: boolean; run?: ToolRun; log?: string[] } = {},
  ) {
    this.definition = {
      name,
      description: `Scripted test tool ${name}`,
      inputSchema: { type: "object", properties: {} },
    };
    this.needsApproval = options.needsApproval ?? false;
    this.#run = options.run ?? (() => ({ result: `${name} done`, isError: false }));
    this.#log = options.log;
  }

  async execute(input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutput> {
    this.calls.push({ input, signal });
    this.#log?.push(`${this.definition.name}:start`);
    try {
      return await this.#run(input, signal);
    } finally {
      this.#log?.push(`${this.definition.name}:end`);
    }
  }
}

export const untilAborted =
  (result = "interrupted"): ToolRun =>
  (_input, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve({ result, isError: true });
        return;
      }
      signal.addEventListener("abort", () => resolve({ result, isError: true }), { once: true });
    });
