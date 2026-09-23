/** Session-level guidance advertised by the MCP server. */
export const MCP_INSTRUCTIONS = [
  "Jev tool routing: when a task matches a case below, call that tool before answering; do not substitute one tool for another.",
  "- Use typesafe_ask for a probability, likelihood, comparison, recommendation, or choice that is not an evidence check or ranking of supplied candidates. Include focused state and explicit questions.",
  "- Use typesafe_rank to order or prioritize an explicit candidate set against a query. Pass the supplied candidates; it does not search for them. Use its returned order and scores as-is. Scores are per-candidate, not normalized across the list; the top candidate may still be a weak match.",
  "- Use typesafe_verify to check specific claims against supplied evidence, especially before presenting evidence-based conclusions. Pass the exact claims and relevant evidence; a relevance rank is not proof. If evidence is missing, ask for it rather than inventing it.",
  "For deterministic arithmetic or lookups, do not call an unrelated tool. If Jev fails, signals low confidence, or returns only weak relevance scores, report that limitation rather than inventing an answer.",
  "Keep inputs focused. Credentials are redacted for rank and verify; redact secrets from ask state yourself, and do not send raw proprietary code.",
].join("\n");
