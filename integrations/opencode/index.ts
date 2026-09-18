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

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  "[Jev policy] This asks for a quantitative judgment. Call the typesafe_ask tool before writing that judgment.";

const DIRECTIVE_TAG = "[Jev policy]";

/** First matching pattern name, or undefined when the text needs no routing. */
export function recallMatch(prompt: string): string | undefined {
  for (const { name, regex } of RECALL_PATTERNS) {
    if (regex.test(prompt)) return name;
  }
  return undefined;
}

/** True when the text asks for a routed judgment (recall prefilter). */
export function jevPromptRecall(prompt: string): boolean {
  return recallMatch(prompt) !== undefined;
}

interface HookFireEntry {
  readonly ts: string;
  readonly sessionID: string;
  readonly pattern: string;
  readonly excerpt: string;
  readonly directivePushed: boolean;
}

/** Local-only telemetry path; honors JEV_DATA_DIR like the rest of the toolkit. */
export function hookFireLogPath(): string {
  const root = process.env.JEV_DATA_DIR ?? join(homedir(), ".local", "share", "jev");
  return join(root, "hook-fires.jsonl");
}

/**
 * Record one hook fire. Fail-safe by contract: telemetry must never break a
 * model call, so every filesystem failure is swallowed after the attempt.
 */
export function appendHookFire(entry: HookFireEntry, path: string = hookFireLogPath()): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Telemetry is best-effort by design; a logging failure never fails the call.
    return;
  }
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

/**
 * Push the directive when the latest user turn asks for a routed judgment,
 * and record the fire locally so hook demand can be compared against actual
 * Jev calls (`~/.local/share/jev/hook-fires.jsonl` vs `events.jsonl`).
 */
export function handleSessionContext(event: SessionContextEvent): void {
  const prompt = lastUserText(event.messages ?? []);
  const pattern = recallMatch(prompt);
  if (pattern === undefined) return;
  const system = (event.system ??= []);
  const tagged = system.some((entry) => entry.text.includes(DIRECTIVE_TAG));
  const directivePushed = !tagged;
  if (directivePushed) system.push({ type: "text", text: RECALL_DIRECTIVE });
  appendHookFire({
    ts: new Date().toISOString(),
    sessionID: event.sessionID ?? "",
    pattern,
    excerpt: prompt.slice(0, 120),
    directivePushed,
  });
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
