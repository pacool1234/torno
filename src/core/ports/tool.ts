import type { ToolDefinition } from "./model-provider.ts";

export type ToolOutput = {
  result: string;
  isError: boolean;
};

export interface Tool {
  readonly definition: ToolDefinition;

  readonly needsApproval: boolean;

  execute(input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutput>;
}
