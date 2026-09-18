import { describe, expect, it } from "vitest";
import { matchQuantitativeClaim } from "../../src/core/detector.ts";
import { PROMPT_DIRECTIVE } from "../../src/core/directives.ts";
import {
  jevPromptRecall,
  lastUserText,
  registerJevPlugin,
} from "../../integrations/opencode/index.ts";
import { jevPromptRecall as piRecall } from "../../integrations/pi/index.ts";

interface HookSystemEntry {
  readonly type: "text";
  text: string;
}

interface HookContentPart {
  readonly type: string;
  readonly text?: string;
}

interface HookMessage {
  readonly role: string;
  readonly content: ReadonlyArray<HookContentPart>;
}

interface HookEvent {
  system?: Array<HookSystemEntry>;
  readonly messages?: ReadonlyArray<HookMessage>;
}

type ContextHandler = (event: HookEvent) => void;

function loadHandler(): ContextHandler {
  const handlers = new Map<string, ContextHandler>();
  const plugin = {
    session: {
      hook: (event: "context", handler: ContextHandler): Promise<void> => {
        handlers.set(event, handler);
        return Promise.resolve();
      },
    },
  };
  expect(registerJevPlugin(plugin)).toBeInstanceOf(Promise);
  const handler = handlers.get("context");
  expect(handler).toBeDefined();
  if (handler === undefined) {
    throw new Error("context handler was not registered");
  }
  return handler;
}

const userMessage = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
});

describe("jevPromptRecall (opencode)", () => {
  it("fires on the ticket-approach prompt that previously slipped through", () => {
    expect(jevPromptRecall("what should be the best approach to implement this ticket")).toBe(true);
  });

  it("fires on implementation-approach asks without other trigger words", () => {
    expect(jevPromptRecall("What is the implementation plan for the export?")).toBe(true);
    expect(jevPromptRecall("how should we design the export endpoint?")).toBe(true);
  });

  it("stays silent on lookups and neutral status prompts", () => {
    expect(jevPromptRecall("What is the capital of France?")).toBe(false);
    expect(jevPromptRecall("how to run the tests locally")).toBe(false);
    expect(jevPromptRecall("status: all systems nominal")).toBe(false);
  });

  it("agrees with the detector and the pi copy on every battery prompt", () => {
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
      const expected = matchQuantitativeClaim(prompt).length > 0;
      expect(jevPromptRecall(prompt), `opencode: ${prompt}`).toBe(expected);
      expect(piRecall(prompt), `pi: ${prompt}`).toBe(expected);
    }
  });
});

describe("lastUserText", () => {
  it("returns the latest user text and skips assistant and tool messages", () => {
    expect(
      lastUserText([
        userMessage("first question"),
        { role: "assistant", content: [{ type: "text", text: "draft answer" }] },
        { role: "tool", content: [{ type: "text", text: "tool output" }] },
        userMessage("second question"),
      ]),
    ).toBe("second question");
  });

  it("returns empty string when no user message exists", () => {
    expect(lastUserText([])).toBe("");
    expect(lastUserText([{ role: "assistant", content: [{ type: "text", text: "hi" }] }])).toBe("");
  });
});

describe("handleSessionContext", () => {
  it("pushes the shared directive on a match and leaves history untouched", () => {
    const handler = loadHandler();
    const event = {
      system: [{ type: "text" as const, text: "base" }],
      messages: [userMessage("what should be the best approach to implement this ticket")],
    };
    handler(event);
    expect(event.system).toEqual([
      { type: "text", text: "base" },
      { type: "text", text: PROMPT_DIRECTIVE },
    ]);
    expect(event.messages).toHaveLength(1);
  });

  it("stays silent on neutral prompts", () => {
    const handler = loadHandler();
    const event = {
      system: [{ type: "text" as const, text: "base" }],
      messages: [userMessage("status: all systems nominal")],
    };
    handler(event);
    expect(event.system).toEqual([{ type: "text", text: "base" }]);
  });

  it("never duplicates the directive", () => {
    const handler = loadHandler();
    const event = {
      system: [{ type: "text" as const, text: `base\n\n${PROMPT_DIRECTIVE}` }],
      messages: [userMessage("which option is best, A versus B?")],
    };
    handler(event);
    expect(event.system).toHaveLength(1);
  });

  it("creates the system list when the host omits it", () => {
    const handler = loadHandler();
    const event: HookEvent = {
      messages: [userMessage("compare backend xlsx against a csv export")],
    };
    handler(event);
    expect(event.system).toEqual([{ type: "text", text: PROMPT_DIRECTIVE }]);
  });
});
