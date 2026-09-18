// Pi/OMP prompt-recall extension: append the Jev directive to the system
// prompt when the user prompt asks for a quantitative judgment. Non-blocking
// and silent otherwise.
//
// Self-contained by necessity: pi/OMP discover extensions through a symlinked
// path and resolve relative imports lexically against the link location, so
// `../../src/...` imports fail at load (verified: jiti MODULE_NOT_FOUND).
// The patterns below mirror `src/core/detector.ts` PATTERNS and the directive
// mirrors `src/core/directives.ts` PROMPT_DIRECTIVE; agreement between the two
// copies is pinned by tests/integrations/pi-extension.test.ts. Local
// structural types only, so OMP (which vendors the Pi extension API) loads the
// same file.

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

interface BeforeAgentStartEvent {
  prompt: string;
  systemPrompt: string;
}

interface BeforeAgentStartResult {
  systemPrompt?: string;
}

interface PromptRecallApi {
  on(
    event: "before_agent_start",
    handler: (event: BeforeAgentStartEvent) => BeforeAgentStartResult | undefined | void,
  ): void;
}

/** True when the prompt asks for a routed judgment (recall prefilter). */
export function jevPromptRecall(prompt: string): boolean {
  return RECALL_PATTERNS.some((pattern) => pattern.test(prompt));
}

export function registerJevExtension(pi: PromptRecallApi): void {
  pi.on("before_agent_start", (event) => {
    if (!jevPromptRecall(event.prompt)) {
      return;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${RECALL_DIRECTIVE}` };
  });
}

export default function (pi: PromptRecallApi): void {
  registerJevExtension(pi);
}
