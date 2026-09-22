// Jev prompt-recall plugin for OpenCode V2 (native, zero-dependency).
//
// Two hooks, one prefilter (a mirror of `src/core/detector.ts` PATTERNS):
//
// - `prompt`: when the incoming user text asks for a routed judgment, append a
//   task-specific echo to the prompt itself. This speaks to the observed
//   failure mode — the model explores the code, then treats its derived
//   recommendation as a lookup rather than a judgment. Appending keeps the
//   instruction in user-visible text, which survives better than system
//   context. Edits are end-appends only, so attachment mention offsets are
//   unaffected, and the echo is skipped when already present (retry-safe).
// - `context`: before each agent-loop model call, push the Jev directive onto
//   `event.system` when the latest user text matches. Changes affect only the
//   outgoing call, never persisted history. Auxiliary requests (`title`,
//   `compaction`, `generate`) are skipped so background calls stay quiet.
//
// Self-contained by necessity, like `integrations/pi/index.ts`: the host
// loads this file directly, so `../../src/...` imports fail at load. The
// patterns below mirror `src/core/detector.ts` PATTERNS and the directive
// mirrors `src/core/directives.ts` PROMPT_DIRECTIVE; agreement between all
// three copies is pinned by tests/integrations/opencode-plugin.test.ts.
// Local structural types only, so no `@opencode/plugin` install is needed
// and the default export stays a plain object the host can call.

const RECALL_PATTERNS: ReadonlyArray<{ readonly name: string; readonly regex: RegExp }> = [
  { name: "percent", regex: /\b\d+(?:\.\d+)?\s?%/ },
  { name: "probability", regex: /\b(?:probability|probabilistic|likely|unlikely|chance|odds)\b/i },
  {
    name: "ranking",
    regex: /\b(?:rank(?:ed|ing)?|prioriti[sz]e[ds]?|top \d+|best|worst|trade-?offs?)\b/i,
  },
  {
    name: "estimate",
    regex: /\b(?:estimate|roughly|approximately|about \d+|quantify|measure|how (?:much|many))\b/i,
  },
  {
    name: "choice",
    regex: /\b(?:should (?:we|i)|which (?:is|one|option|approach|plan|design)|choose between)\b/i,
  },
  {
    name: "choice",
    regex: /\b(?:recommend(?:ation|ed|s)?|assess(?:ment)?|evaluate|advise|suggest)\b/i,
  },
  {
    name: "choice",
    regex: /\b(?:compare|contrast|weigh|decide (?:between|whether)|pick (?:one|between))\b/i,
  },
  {
    name: "choice",
    regex: /\bhow (?:should|do we)\b/i,
  },
  {
    name: "choice",
    regex:
      /\bwhat (?:is|should be)\b[^.?!]{0,80}\b(?:approach|plan|design|strategy|option|implement)\b/i,
  },
  { name: "choice", regex: /\b(?:versus|vs)\b/i },
];

const RECALL_DIRECTIVE =
  "[Jev policy] This asks for a quantitative judgment. Call the typesafe_ask tool before writing " +
  "that judgment. If choosing which skill(s) to load from a candidate catalog, call " +
  "typesafe_skill_route with the candidates instead, then load only the returned skills.";

export const PROMPT_ECHO =
  "[Jev policy] Exploring the code first does not replace this step: a code-derived " +
  "recommendation is still a choice among alternatives. Before recommending an approach, " +
  "call the typesafe_ask tool with the alternatives, then report its answer with " +
  "confidence as from Jev. When the choice is which skills to load, use " +
  "typesafe_skill_route with the candidate names and descriptions instead.";

const DIRECTIVE_TAG = "[Jev policy]";

/** True when the text asks for a routed judgment (recall prefilter). */
export function jevPromptRecall(prompt: string): boolean {
  return RECALL_PATTERNS.some(({ regex }) => regex.test(prompt));
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
  readonly sessionID?: string;
  system?: Array<SystemEntry>;
  readonly messages?: ReadonlyArray<ContextMessage>;
}

interface PromptPayload {
  text?: string;
}

interface SessionPromptEvent {
  readonly sessionID?: string;
  readonly prompt?: PromptPayload;
}

interface SessionHooks {
  hook(event: "context", handler: (hookEvent: SessionContextEvent) => void): Promise<void>;
  hook(event: "prompt", handler: (hookEvent: SessionPromptEvent) => void): Promise<void>;
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

/**
 * Append the task-specific echo to the admitted prompt itself. End-append
 * only, so existing attachment mention offsets are unaffected; skipped when
 * the text already carries the tag, which keeps concurrent or retried
 * admissions from duplicating it.
 */
export function handleSessionPrompt(event: SessionPromptEvent): void {
  if (event.prompt === undefined) return;
  const text = event.prompt.text ?? "";
  if (!jevPromptRecall(text)) return;
  if (text.includes(DIRECTIVE_TAG)) return;
  event.prompt.text = `${text}\n\n${PROMPT_ECHO}`;
}

export function registerJevPlugin(plugin: JevPluginContext): Promise<void> {
  const registered = [
    plugin.session.hook("context", handleSessionContext),
    plugin.session.hook("prompt", handleSessionPrompt),
  ];
  return Promise.all(registered).then(() => undefined);
}

const plugin = {
  id: "jev",
  setup(ctx: JevPluginContext): Promise<void> {
    return registerJevPlugin(ctx);
  },
};

export default plugin;
