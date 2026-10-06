// The agent loop (agent-loop change). Group 2: one step, no tools yet. The
// shape is the final one: `runTurn` adds the prompt, runs steps, and always
// ends with one `turn_ended` carrying the new conversation (design D1).

import type { AgentConfig, AgentEvent } from "./agent.ts";
import type {
  AssistantContentBlock,
  Message,
  NonEmptyArray,
  UserContentBlock,
} from "./conversation.ts";
import type { ProviderRequest, StopReason, Usage } from "./ports/model-provider.ts";

export async function* runTurn(
  config: AgentConfig,
  conversation: readonly Message[],
  prompt: string,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  // A fresh array the loop may push to. The caller's array is never touched
  // (design D1: the caller owns its conversation and keeps the one returned).
  const messages: Message[] = withPrompt(conversation, prompt);

  const step = 1;
  const response = yield* streamStep(config, messages, signal, step);
  if (isNonEmpty(response.content)) {
    messages.push({ role: "assistant", content: response.content });
  }
  yield { type: "turn_ended", reason: "completed", conversation: messages };
}

// Adds the prompt so that roles keep alternating (design D2). After a turn
// that stopped early, the conversation can end with a user message (tool
// results, or a prompt the model never answered); a second user message in a
// row would break the invariant, so the prompt joins that message instead.
function withPrompt(conversation: readonly Message[], prompt: string): Message[] {
  const promptBlock = { type: "text", text: prompt } as const;
  const last = conversation.at(-1);
  if (last?.role === "user") {
    // A new message object with the block added at the end: tool results stay
    // first, which Anthropic requires when results and text share a message.
    const content: NonEmptyArray<UserContentBlock> = [...last.content, promptBlock];
    return [...conversation.slice(0, -1), { role: "user", content }];
  }
  return [...conversation, { role: "user", content: [promptBlock] }];
}

type StepResponse = {
  content: AssistantContentBlock[];
  stopReason: StopReason;
  usage: Usage;
};

// One model request. Forwards what streams back as agent events, and builds
// the assistant message's content as it goes. It's a generator called with
// `yield*`: its yields pass straight through to runTurn's consumer, and its
// `return` value becomes the value of the `yield*` expression, which is how
// it hands the finished response back.
async function* streamStep(
  config: AgentConfig,
  messages: readonly Message[],
  signal: AbortSignal,
  step: number,
): AsyncGenerator<AgentEvent, StepResponse> {
  const request: ProviderRequest = {
    model: config.model,
    // Only when set: the port says "system?: string", and an adapter may
    // treat a present-but-undefined key differently from an absent one.
    ...(config.system === undefined ? {} : { system: config.system }),
    tools: config.tools.map((tool) => tool.definition),
    maxOutputTokens: config.maxOutputTokens,
    // A copy, so pushing to `messages` after this step can't change the
    // request a provider might still be holding.
    messages: nonEmptyCopy(messages),
    signal,
  };

  const content: AssistantContentBlock[] = [];
  // Text fragments are joined into one block per run of text: the
  // conversation records what the model said, not how it was chunked.
  let text = "";
  const flushText = (): void => {
    if (text !== "") {
      content.push({ type: "text", text });
      text = "";
    }
  };

  for await (const event of config.provider.stream(request)) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        yield event;
        break;
      case "tool_call_started":
        yield event;
        break;
      case "tool_call_completed":
        // Text before the call stays before it, so the assistant message
        // keeps the order the model produced ("Let me look." then the call).
        flushText();
        content.push(event.call);
        break;
      case "response_completed":
        flushText();
        yield {
          type: "step_completed",
          step,
          stopReason: event.stopReason,
          usage: event.usage,
          skippedBlocks: event.skippedBlocks,
        };
        // The port guarantees nothing follows the completion, so stop here.
        return { content, stopReason: event.stopReason, usage: event.usage };
      default: {
        const unhandled: never = event;
        throw new Error(`Unhandled stream event: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  // The port promises exactly one completion before a normal end; a stream
  // that ends without one is a broken provider, i.e. a bug, so it throws.
  throw new Error("The provider's stream ended without a response_completed event");
}

// Copies a list the caller knows is non-empty into the non-empty tuple type
// the port requires. TypeScript can't prove "the conversation plus the prompt"
// is non-empty, so this checks it at runtime instead of casting: if a bug ever
// made it empty, this throws here rather than sending an invalid request.
function nonEmptyCopy<T>(items: readonly T[]): NonEmptyArray<T> {
  const [first, ...rest] = items;
  if (first === undefined) {
    throw new Error("Expected a non-empty list");
  }
  return [first, ...rest];
}

// A type guard: when it returns true, TypeScript treats `items` as a non-empty
// tuple, which is what a message's `content` requires.
function isNonEmpty<T>(items: T[]): items is [T, ...T[]] {
  return items.length > 0;
}
