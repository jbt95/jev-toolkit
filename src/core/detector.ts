export interface ClaimMatch {
  readonly pattern: string;
  readonly matched: string;
}

interface ClaimPattern {
  readonly name: string;
  readonly regex: RegExp;
}

const PATTERNS: ReadonlyArray<ClaimPattern> = [
  { name: "percent", regex: /\b\d+(?:\.\d+)?\s?%/ },
  {
    name: "probability",
    regex: /\b(?:probability|probabilistic|likely|unlikely|chance|odds)\b/i,
  },
  { name: "ranking", regex: /\b(?:rank(?:ed|ing)?|prioriti[sz]e[ds]?|top \d+|best|worst)\b/i },
  { name: "estimate", regex: /\b(?:estimate|roughly|approximately|about \d+)\b/i },
  { name: "choice", regex: /\b(?:should (?:we|i)|which (?:is|one|option)|choose between)\b/i },
];

/** First match per claim pattern; a text may match several patterns. */
export function matchQuantitativeClaim(text: string): ReadonlyArray<ClaimMatch> {
  const matches: Array<ClaimMatch> = [];
  for (const { name, regex } of PATTERNS) {
    const found = regex.exec(text);
    if (found !== null) matches.push({ pattern: name, matched: found[0] });
  }
  return matches;
}
