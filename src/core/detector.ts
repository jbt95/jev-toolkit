export interface ClaimMatch {
  readonly pattern: string;
  readonly matched: string;
}

interface ClaimPattern {
  readonly name: string;
  readonly regex: RegExp;
}

/**
 * Lexical cues that a text asks for (or asserts) a quantitative judgment.
 *
 * This is a recall-oriented prefilter, not the classifier: the prompt directive
 * and the prompt audit use it to decide whether to route a user turn through
 * Jev, while the claim taxonomy is assigned by Jev itself. Several regexes may
 * share a kind (recommendation/assessment/comparison are all `choice`), so the
 * first matching regex per kind wins.
 */
const PATTERNS: ReadonlyArray<ClaimPattern> = [
  { name: "percent", regex: /\b\d+(?:\.\d+)?\s?%/ },
  {
    name: "probability",
    regex: /\b(?:probability|probabilistic|likely|unlikely|chance|odds)\b/i,
  },
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
    regex: /\b(?:should (?:we|i)|which (?:is|one|option|approach)|choose between)\b/i,
  },
  {
    // A recommendation or assessment is a choice among alternatives even when
    // it never uses the word "choice" ("assess how we can achieve that").
    name: "choice",
    regex: /\b(?:recommend(?:ation|ed|s)?|assess(?:ment)?|evaluate|advise|suggest)\b/i,
  },
  {
    // Explicit option comparison, with or without "should".
    name: "choice",
    regex: /\b(?:compare|contrast|weigh|decide (?:between|whether)|pick (?:one|between))\b/i,
  },
  { name: "choice", regex: /\b(?:versus|vs)\b/i },
];

/** First match per claim kind; a text may match several kinds. */
export function matchQuantitativeClaim(text: string): ReadonlyArray<ClaimMatch> {
  const matches: Array<ClaimMatch> = [];
  const seen = new Set<string>();
  for (const { name, regex } of PATTERNS) {
    if (seen.has(name)) continue;
    const found = regex.exec(text);
    if (found !== null) {
      seen.add(name);
      matches.push({ pattern: name, matched: found[0] });
    }
  }
  return matches;
}
