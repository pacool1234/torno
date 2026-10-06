import { describeModelProviderContract } from "../../../../test/contract/model-provider-contract.ts";
import type { ContractSituation } from "../../../../test/contract/model-provider-contract.ts";
import { type FakeResponse, fakeFetch } from "../../../../test/helpers/fake-fetch.ts";
import { loadFixture, offsetAfterFirstText } from "../../../../test/helpers/fixtures.ts";
import { AnthropicProvider } from "./anthropic-provider.ts";

const text = loadFixture("haiku-text");
const toolCall = loadFixture("haiku-tool-call");

const firstTextOnly = text.body.subarray(0, offsetAfterFirstText(text.body));

function responseFor(situation: ContractSituation): FakeResponse {
  switch (situation) {
    case "text_only":
      return { chunks: [text.body] };
    case "text_then_tool_call":
      return { chunks: [toolCall.body] };
    case "failure_after_text":
      return { chunks: [firstTextOnly], end: "error" };
    case "never_finishes":
      return { chunks: [firstTextOnly], end: "hang" };
    default: {
      const unhandled: never = situation;
      throw new Error(`Unhandled situation: ${String(unhandled)}`);
    }
  }
}

describeModelProviderContract("AnthropicProvider (recorded responses)", (situation) => {
  const fake = fakeFetch(responseFor(situation));
  const provider = new AnthropicProvider({ baseUrl: "https://api.test", fetch: fake.fetch });
  return { provider, openResources: fake.openBodies };
});
