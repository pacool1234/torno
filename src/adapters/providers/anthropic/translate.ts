import { z } from "zod";
import {
  ProviderError,
  type StopReason,
  type StreamEvent,
  type Usage,
} from "../../../core/ports/model-provider.ts";
import type { ServerSentEvent } from "./event-stream.ts";
import { kindForErrorType } from "./errors.ts";
import { wireEventSchemas } from "./wire-events.ts";

type OpenBlock =
  | { kind: "text" }
  | { kind: "tool_use"; id: string; name: string; inputJson: string }
  | { kind: "unsupported" };

type Counts = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export async function* translateStream(
  events: AsyncIterable<ServerSentEvent>,
): AsyncGenerator<StreamEvent> {
  const blocks = new Map<number, OpenBlock>();
  const counts: Counts = {};
  let skippedBlocks = 0;
  let wireStopReason: string | null | undefined;

  for await (const sse of events) {
    switch (sse.event) {
      case "message_start": {
        const { message } = parse(wireEventSchemas.message_start, sse);
        recordCounts(counts, message.usage);
        break;
      }

      case "content_block_start": {
        const { index, content_block: block } = parse(wireEventSchemas.content_block_start, sse);
        if (block.type === "text") {
          blocks.set(index, { kind: "text" });
        } else if (block.type === "tool_use") {
          blocks.set(index, { kind: "tool_use", id: block.id, name: block.name, inputJson: "" });
          yield { type: "tool_call_started", id: block.id, toolName: block.name };
        } else {
          blocks.set(index, { kind: "unsupported" });
          skippedBlocks += 1;
        }
        break;
      }

      case "content_block_delta": {
        const { index, delta } = parse(wireEventSchemas.content_block_delta, sse);
        const block = openBlock(blocks, index);
        if (block.kind === "unsupported" || delta.type === "unsupported") {
          break;
        }
        if (delta.type === "text_delta") {
          if (block.kind !== "text") {
            throw protocolError(`text_delta for block ${index}, which is not a text block`);
          }
          if (delta.text !== "") {
            yield { type: "text_delta", text: delta.text };
          }
        } else {
          if (block.kind !== "tool_use") {
            throw protocolError(`input_json_delta for block ${index}, which is not a tool call`);
          }
          block.inputJson += delta.partial_json;
        }
        break;
      }

      case "content_block_stop": {
        const { index } = parse(wireEventSchemas.content_block_stop, sse);
        const block = openBlock(blocks, index);
        blocks.delete(index);
        if (block.kind === "tool_use") {
          yield {
            type: "tool_call_completed",
            call: {
              type: "tool_call",
              id: block.id,
              toolName: block.name,
              input: parseToolInput(block.inputJson, block.name),
            },
          };
        }
        break;
      }

      case "message_delta": {
        const { delta, usage } = parse(wireEventSchemas.message_delta, sse);
        wireStopReason = delta.stop_reason ?? wireStopReason;
        recordCounts(counts, usage);
        break;
      }

      case "message_stop": {
        parse(wireEventSchemas.message_stop, sse);
        yield completion(blocks, counts, skippedBlocks, wireStopReason);
        return;
      }

      case "error": {
        const { error } = parse(wireEventSchemas.error, sse);
        throw new ProviderError(kindForErrorType(error.type), `${error.type}: ${error.message}`);
      }

      default:
        break;
    }
  }

  throw new ProviderError("network", "The response ended before it was complete (no message_stop)");
}

function parse<S extends z.ZodType>(schema: S, sse: ServerSentEvent): z.output<S> {
  let json: unknown;
  try {
    json = JSON.parse(sse.data);
  } catch (cause: unknown) {
    throw new ProviderError("protocol", `The "${sse.event}" event's data is not valid JSON`, {
      cause,
    });
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ProviderError(
      "protocol",
      `Unexpected "${sse.event}" event:\n${z.prettifyError(result.error)}`,
      { cause: result.error },
    );
  }
  return result.data;
}

function openBlock(blocks: Map<number, OpenBlock>, index: number): OpenBlock {
  const block = blocks.get(index);
  if (block === undefined) {
    throw protocolError(`event for content block ${index}, which was never started`);
  }
  return block;
}

function parseToolInput(inputJson: string, toolName: string): Record<string, unknown> {
  if (inputJson === "") {
    return {};
  }
  let input: unknown;
  try {
    input = JSON.parse(inputJson);
  } catch (cause: unknown) {
    throw new ProviderError("protocol", `The input for tool "${toolName}" is not valid JSON`, {
      cause,
    });
  }
  if (!isRecord(input)) {
    throw protocolError(`the input for tool "${toolName}" is not a JSON object`);
  }
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordCounts(
  counts: Counts,
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  },
): void {
  if (usage.input_tokens != null) counts.input = usage.input_tokens;
  if (usage.output_tokens != null) counts.output = usage.output_tokens;
  if (usage.cache_read_input_tokens != null) counts.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens != null) {
    counts.cacheWrite = usage.cache_creation_input_tokens;
  }
}

function completion(
  blocks: Map<number, OpenBlock>,
  counts: Counts,
  skippedBlocks: number,
  wireStopReason: string | null | undefined,
): StreamEvent {
  for (const block of blocks.values()) {
    if (block.kind === "tool_use") {
      throw protocolError(`tool call "${block.name}" was never completed`);
    }
  }
  if (counts.input === undefined || counts.output === undefined) {
    throw protocolError("the response ended without reporting its token usage");
  }

  const usage: Usage = {
    inputTokens: counts.input,
    outputTokens: counts.output,
    ...(counts.cacheRead === undefined ? {} : { cacheReadTokens: counts.cacheRead }),
    ...(counts.cacheWrite === undefined ? {} : { cacheWriteTokens: counts.cacheWrite }),
  };
  return {
    type: "response_completed",
    stopReason: toStopReason(wireStopReason),
    usage,
    skippedBlocks,
  };
}

function toStopReason(wire: string | null | undefined): StopReason {
  switch (wire) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
      return wire;
    default:
      return "other";
  }
}

function protocolError(problem: string): ProviderError {
  return new ProviderError("protocol", `Unexpected stream from the server: ${problem}`);
}
