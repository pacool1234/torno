// The agent loop (agent-loop change). `runTurn` adds the prompt, runs steps
// (a model request, then the tools it asked for) and always ends with one
// `turn_ended` carrying the new conversation (design D1).
//
// Cancellation is checked at fixed points rather than everywhere: before each
// model request, before each tool call, and after an approval. Between those
// points the signal is passed down (provider, approver, tool), so whatever is
// running at the moment of Ctrl-C stops itself; the checks then make sure the
// loop starts nothing new.

import type { AgentConfig, AgentEvent } from "./agent.ts";
import type {
  AssistantContentBlock,
  Message,
  NonEmptyArray,
  ToolCallBlock,
  ToolResultBlock,
  UserContentBlock,
} from "./conversation.ts";
import { ProviderError, type ProviderRequest, type StopReason } from "./ports/model-provider.ts";
import type { ApprovalDecision } from "./ports/approver.ts";
import type { Tool, ToolOutput } from "./ports/tool.ts";

// Results the model reads for calls that weren't run normally. Fixed texts,
// written for the model: it should understand what happened and react (try
// another tool, ask the user) rather than retry blindly.
const DENIED = "The user denied this tool call.";
const NOT_RUN_OUTPUT_LIMIT = "Not run: the response hit the output limit.";
const NOT_RUN_CANCELLED = "Not run: the user cancelled.";

// ADR-0008: the most of one tool result the model gets to see. About 7,500
// tokens; a result over it keeps its head and its tail, half each.
const MAX_RESULT_CHARS = 30_000;
const KEPT_EACH_SIDE = MAX_RESULT_CHARS / 2;

// Consumers must read until `turn_ended`: it's the only place the updated
// conversation comes out. To stop a turn early, abort the signal; breaking
// out of the `for await` instead stops the loop at its current event, and the
// conversation of that turn is lost.
export async function* runTurn(
  config: AgentConfig,
  conversation: readonly Message[],
  prompt: string,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  // A fresh array the loop may push to. The caller's array is never touched
  // (design D1: the caller owns its conversation and keeps the one returned).
  const messages: Message[] = withPrompt(conversation, prompt);

  // With maxSteps below 1 the loop would still make one request, breaking
  // "at most maxSteps". An impossible setting is a bug in the caller's
  // configuration, so it throws (design D1) before anything is sent.
  if (!Number.isInteger(config.maxSteps) || config.maxSteps < 1) {
    throw new RangeError(`maxSteps must be a whole number of at least 1, got ${config.maxSteps}`);
  }

  // Looked up by name for every call; built once per turn.
  const tools = new Map(config.tools.map((tool) => [tool.definition.name, tool]));

  for (let step = 1; ; step += 1) {
    // Checkpoint 1: before each request. Covers a signal aborted before the
    // turn started, and Ctrl-C while the previous step's last tool finished.
    if (signal.aborted) {
      yield { type: "turn_ended", reason: "cancelled", conversation: messages };
      return;
    }

    let response: StepResponse;
    try {
      response = yield* streamStep(config, messages, signal, step);
    } catch (error: unknown) {
      // A provider failure is an expected outcome (design D1): it ends the
      // turn as a reason. Nothing from this step has been added to
      // `messages` yet, so the step in progress is dropped and every finished
      // step stays (design D2). No retry (ADR-0007): the user decides.
      //
      // A cancellation surfaces from the provider as kind "aborted". The
      // signal is checked too: if Ctrl-C raced with a network error, the user
      // still asked to stop, so the turn ends as cancelled, not failed.
      if (error instanceof ProviderError && (error.kind === "aborted" || signal.aborted)) {
        yield { type: "turn_ended", reason: "cancelled", conversation: messages };
        return;
      }
      if (error instanceof ProviderError) {
        yield { type: "turn_ended", reason: "failed", error, conversation: messages };
        return;
      }
      // Anything else is a bug, and bugs propagate.
      throw error;
    }

    if (isNonEmpty(response.content)) {
      messages.push({ role: "assistant", content: response.content });
    }

    const calls = response.content.filter((block) => block.type === "tool_call");

    // Design D4: a response cut by the output limit ends the turn. Its text is
    // kept (already pushed above). Its complete calls are not run, since the
    // model may have meant to say more, but each still gets a result:
    // without one, the conversation couldn't be sent again (design D2).
    if (response.stopReason === "max_tokens") {
      const results: ToolResultBlock[] = [];
      for (const call of calls) {
        const result = notRun(call, NOT_RUN_OUTPUT_LIMIT);
        yield { type: "tool_finished", call, result };
        results.push(result);
      }
      if (isNonEmpty(results)) {
        messages.push({ role: "user", content: results });
      }
      yield { type: "turn_ended", reason: "max_tokens", conversation: messages };
      return;
    }

    // Tools run only when the model stopped *in order to* use them. Any other
    // stop reason means its turn is over; "tool_use" with no complete call
    // leaves nothing to run, so the turn ends too.
    if (response.stopReason !== "tool_use" || !isNonEmpty(calls)) {
      yield { type: "turn_ended", reason: "completed", conversation: messages };
      return;
    }

    // One at a time, in the model's order (ADR-0007). A `for` loop with
    // `await` inside is what makes it sequential; `Promise.all` would start
    // them all at once, which is the deferred "parallel tool calls".
    const results: ToolResultBlock[] = [];
    for (const call of calls) {
      // Checkpoint 2: before each call. After Ctrl-C, the remaining calls
      // still get a result each (design D2), or the conversation couldn't
      // be sent again.
      if (signal.aborted) {
        const result = notRun(call, NOT_RUN_CANCELLED);
        yield { type: "tool_finished", call, result };
        results.push(result);
        continue;
      }
      results.push(yield* runCall(config, tools, call, signal));
    }
    // All of the step's results in one user message (ADR-0007), in call
    // order: a message per result would put two user messages in a row.
    messages.push({ role: "user", content: nonEmptyCopy(results) });

    // Checked before the step limit: the user's Ctrl-C is the more useful
    // thing to report when both happen in the same step.
    if (signal.aborted) {
      yield { type: "turn_ended", reason: "cancelled", conversation: messages };
      return;
    }

    // Design D4: the limit is checked after the step's tools ran, so their
    // results are kept and "continue" picks up exactly here. Checked before
    // the next request, so the model is called at most maxSteps times.
    if (step >= config.maxSteps) {
      yield { type: "turn_ended", reason: "step_limit", conversation: messages };
      return;
    }
  }
}

function notRun(call: ToolCallBlock, reason: string): ToolResultBlock {
  return { type: "tool_result", toolCallId: call.id, isError: true, result: reason };
}

// Runs one tool call and reports it: "tool_started" right before the tool
// runs (so never for a call that doesn't run), then "tool_finished" with the
// result, always. Every outcome becomes a result the model can read; nothing
// here throws for a tool's failure.
async function* runCall(
  config: AgentConfig,
  tools: ReadonlyMap<string, Tool>,
  call: ToolCallBlock,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent, ToolResultBlock> {
  const finish = (output: ToolOutput): ToolResultBlock => ({
    type: "tool_result",
    toolCallId: call.id,
    isError: output.isError,
    // Every result a tool produces passes through here, so this one line is
    // the backstop for all tools, present and future (ADR-0008).
    result: capResult(output.result),
  });

  const tool = tools.get(call.toolName);
  if (tool === undefined) {
    // Listing the real names lets the model correct a typo or a guessed name
    // on its next try (spec "Unknown tool").
    const available = [...tools.keys()].join(", ") || "none";
    const result = finish({
      result: `Unknown tool "${call.toolName}". Available tools: ${available}.`,
      isError: true,
    });
    yield { type: "tool_finished", call, result };
    return result;
  }

  // Design D3: approval happens here, in the loop, so it's visible in the
  // events and the same for every tool.
  if (tool.needsApproval) {
    let decision: ApprovalDecision | undefined;
    try {
      decision = await config.approver.approve(call, signal);
    } catch (error: unknown) {
      // An approver may reject when Ctrl-C interrupts its prompt; that's a
      // cancellation, handled below. Rejecting without one is a bug in the
      // approver (design D1: bugs throw).
      if (!signal.aborted) {
        throw error;
      }
    }
    // Checkpoint 3: after the approval. Whatever the approver answered, a
    // question interrupted by Ctrl-C must not lead to running the tool.
    if (signal.aborted) {
      const result = notRun(call, NOT_RUN_CANCELLED);
      yield { type: "tool_finished", call, result };
      return result;
    }
    if (decision === "deny") {
      const result = finish({ result: DENIED, isError: true });
      yield { type: "tool_finished", call, result };
      return result;
    }
  }

  yield { type: "tool_started", call };
  let output: ToolOutput;
  try {
    output = await tool.execute(call.input, signal);
  } catch (error: unknown) {
    // A tool that throws is reported to the model like any failure (spec
    // "Tool throws"). `unknown`, not `Error`: JavaScript can throw anything,
    // so a thrown string must still produce a readable message.
    const message = error instanceof Error ? error.message : String(error);
    output = { result: `The tool failed: ${message}`, isError: true };
  }
  const result = finish(output);
  yield { type: "tool_finished", call, result };
  return result;
}

// Shortens a result over MAX_RESULT_CHARS to its head and tail (ADR-0008).
// Head and tail rather than just the head: a build or test log usually ends
// with the part that matters, the error or the summary.
function capResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) {
    return result;
  }
  // JavaScript strings are sequences of UTF-16 code units, and `length` and
  // `slice` count those units. Characters outside the Basic Multilingual Plane
  // (most emoji) take two units, a "surrogate pair". Cutting between the two
  // leaves half a character, which isn't valid text, so each cut moves one
  // unit outward to keep a pair whole on the side that's dropped.
  let headEnd = KEPT_EACH_SIDE;
  if (isHighSurrogate(result.charCodeAt(headEnd - 1))) {
    headEnd -= 1;
  }
  let tailStart = result.length - KEPT_EACH_SIDE;
  if (isLowSurrogate(result.charCodeAt(tailStart))) {
    tailStart += 1;
  }
  const omitted = tailStart - headEnd;
  // The note is written for the model, so it can ask for less next time.
  return `${result.slice(0, headEnd)}\n\n[... ${omitted} characters left out ...]\n\n${result.slice(tailStart)}`;
}

// The first unit of a surrogate pair is in 0xD800–0xDBFF, the second in
// 0xDC00–0xDFFF; no ordinary character uses those values.
function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
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
        return { content, stopReason: event.stopReason };
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
