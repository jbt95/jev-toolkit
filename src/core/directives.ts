/** Shared trigger text for every harness integration. */

export const PROMPT_DIRECTIVE =
  "[Jev policy] This asks for a quantitative judgment. Call the typesafe_ask tool before writing " +
  "that judgment. If choosing which skill(s) to load from a candidate catalog, call " +
  "typesafe_skill_route with the candidates instead, then load only the returned skills.";

export const CONTEXT_POLICY =
  "Jev test policy: route probabilities, rankings, choices among alternatives, and graded estimates through " +
  "typesafe_ask; route skill selection through typesafe_skill_route; log-first, never invent the number.";

/** Session-level MCP guidance: explicit enough for tool discovery, short enough to retain. */
export const MCP_INSTRUCTIONS =
  "Jev tool policy: call a Jev tool before publishing a probability, likelihood, ranking, comparison, " +
  "choice among alternatives, implementation recommendation, or graded estimate. Use typesafe_skill_route " +
  "(not typesafe_ask) when choosing skills from a candidate catalog; use typesafe_verify for claims against " +
  "evidence and typesafe_review for structured change review. For other judgments, typesafe_ask requires both " +
  'state and questions: {"state":"focused context","questions":{"decision":{"_tag":"choice","instructions":"Pick one.","criteria":{"a":"...","b":"..."}}}}. ' +
  "Do not send query-only payloads or omit questions. Report the result and confidence as from Jev; if a call " +
  "fails, say the judgment is unavailable and never invent a number. Exact arithmetic, lookups, and trivia " +
  "without a decision do not need a call. Keep secrets and raw proprietary code out of state.";
