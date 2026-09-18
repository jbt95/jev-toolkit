// Jev prompt-recall plugin for OpenCode V2 (native, zero-dependency).
//
// Registers a `context` session hook: before each agent-loop model call, the
// latest user text is run through the recall prefilter (a mirror of
// `src/core/detector.ts` PATTERNS); on a match the Jev directive is pushed
// onto `event.system`. Non-blocking and silent otherwise.
//
// Only the `context` hook is used, deliberately. Per the V2 plugins guide the
// `prompt` hook rewrites canonical persisted user input, while `context`
// changes affect only the outgoing model call — the directive must never
// pollute history. Auxiliary requests (`title`, `compaction`, `generate`)
// are skipped so background calls stay quiet.
//
// Self-contained by necessity, like `integrations/pi/index.ts`: the host
// loads this file directly, so `../../src/...` imports fail at load. The
// patterns below mirror `src/core/detector.ts` PATTERNS and the directive
// mirrors `src/core/directives.ts` PROMPT_DIRECTIVE; agreement between all
// three copies is pinned by tests/integrations/opencode-plugin.test.ts.
// Local structural types only, so no `@opencode/plugin` install is needed
// and the default export stays a plain object the host can call.

const RECALL_PATTERNS: ReadonlyArray<RegExp> = [
  /\b\d+(?:\.\d+)?\s?%/,
  /\b(?:probability|probabilistic|likely|unlikely|chance|odds)\b/i,
  /\b(?:rank(?:ed|ing)?|prioriti[sz]e[ds]?|top \d+|best|worst|trade-?offs?)\b/i,
  /\b(?:estimate|roughly|approximately|about \d+|quantify|measure|how (?:much|many))\b/i,
  /\b(?:should (?:we|i)|which (?:is|one|option|approach|plan|design)|choose between)\b/i,
  /\b(?:recommend(?:ation|ed|s)?|assess(?:ment)?|evaluate|advise|suggest)\b/i,
  /\b(?:compare|contrast|weigh|decide (?:between|whether)|pick (?:one|between))\b/i,
  /\bhow (?:should|do we)\b/i,
  /\bwhat (?:is|should be)\b[^.?!]{0,80}\b(?:approach|plan|design|strategy|option|implement)\b/i,
  /\b(?:versus|vs)\b/i,
];

const RECALL_DIRECTIVE =
  "[Jev policy] This asks for a quantitative judgment. Call the typesafe_ask tool before writing that judgment.";

const DIRECTIVE_TAG = "[Jev policy]";

/** True when the text asks for a routed judgment (recall prefilter). */
export function jevPromptRecall(prompt: string): boolean {
  return RECALL_PATTERNS.some((pattern) => pattern.test(prompt));
}

interface ContentPart {
  readonly type: string;
  readonly text?: string;
}

interface ContextMessage {
  readonly role: string;
  readonly content: ReadonlyArray<ContentPart>;
}

interface SystemEntry {
  readonly type: "text";
  text: string;
}

interface SessionContextEvent {
  system?: Array<SystemEntry>;
  readonly messages?: ReadonlyArray<ContextMessage>;
}

interface SessionHooks {
  hook(event: "context", handler: (hookEvent: SessionContextEvent) => void): Promise<void>;
}

interface JevPluginContext {
  readonly session: SessionHooks;
}

/** Latest user text in the assembled messages, or "" when there is none. */
export function lastUserText(messages: ReadonlyArray<ContextMessage>): string {
  let found = "";
  for (const message of messages) {
    if (message.role !== "user") continue;
    const texts: Array<string> = [];
    for (const part of message.content) {
      const text = part.text ?? "";
      if (text.length > 0) texts.push(text);
    }
    found = texts.join("\n");
  }
  return found;
}

/** Push the directive when the latest user turn asks for a routed judgment. */
export function handleSessionContext(event: SessionContextEvent): void {
  if (!jevPromptRecall(lastUserText(event.messages ?? []))) return;
  const system = (event.system ??= []);
  const tagged = system.some((entry) => entry.text.includes(DIRECTIVE_TAG));
  if (!tagged) system.push({ type: "text", text: RECALL_DIRECTIVE });
}

export function registerJevPlugin(plugin: JevPluginContext): Promise<void> {
  return plugin.session.hook("context", handleSessionContext);
}

const plugin = {
  id: "jev",
  setup(ctx: JevPluginContext): Promise<void> {
    return registerJevPlugin(ctx);
  },
};

export default plugin;
