import { describe, expect, it } from "vitest";
import { matchQuantitativeClaim } from "../../src/core/detector.ts";
import { PROMPT_DIRECTIVE } from "../../src/core/directives.ts";
import { jevPromptRecall, registerJevExtension } from "../../integrations/pi/index.ts";

type RecallHandler = (event: {
  prompt: string;
  systemPrompt: string;
}) => { systemPrompt?: string } | undefined | void;

function loadHandler(): RecallHandler {
  const handlers = new Map<string, RecallHandler>();
  registerJevExtension({
    on: (event, handler) => {
      handlers.set(event, handler);
    },
  });
  const handler = handlers.get("before_agent_start");
  expect(handler).toBeDefined();
  if (handler === undefined) {
    throw new Error("before_agent_start handler was not registered");
  }
  return handler;
}

describe("jevPromptRecall", () => {
  it("fires on the ticket-approach prompt that previously slipped through", () => {
    expect(jevPromptRecall("what should be the best approach to implement this ticket")).toBe(true);
  });

  it("stays silent on a neutral status prompt", () => {
    expect(jevPromptRecall("status: all systems nominal")).toBe(false);
  });

  it("agrees with the shared detector prefilter on every battery prompt", () => {
    const prompts = [
      "what should be the best approach to implement this ticket IILC-295",
      "What is the implementation plan for the export?",
      "how should we design the export endpoint?",
      "can we document how do we weight this?",
      "which plan should we adopt?",
      "which option is best, A versus B?",
      "estimate the failure odds at roughly 30%",
      "recommend how we can achieve that",
      "compare backend xlsx against a csv export",
      "how many retries before we give up",
      "What is the capital of France?",
      "how to run the tests locally",
      "status: all systems nominal",
      "fix the typo in the readme",
    ];
    for (const prompt of prompts) {
      expect(jevPromptRecall(prompt), prompt).toBe(matchQuantitativeClaim(prompt).length > 0);
    }
  });
});

describe("registerJevExtension", () => {
  it("appends the shared directive to the system prompt on a match, silent otherwise", () => {
    const handler = loadHandler();
    const match = handler({ prompt: "which option is best, A versus B?", systemPrompt: "base" });
    expect(match).toEqual({ systemPrompt: `base\n\n${PROMPT_DIRECTIVE}` });
    expect(
      handler({ prompt: "status: all systems nominal", systemPrompt: "base" }),
    ).toBeUndefined();
  });
});
