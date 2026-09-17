const MAX_TEXT = 2000;

/**
 * Strip obvious credential shapes before any text leaves the machine:
 * Authorization / x-api-key / access-token / API-key fields (bare or quoted
 * JSON, camelCase included), `*_TOKEN`/`*_KEY`/`*_SECRET`/`*_PASSWORD` and
 * bare `token`/`secret`/`password` assignments in any case, and standalone
 * Bearer tokens.
 */
export function redact(text: string): string {
  return text
    .replace(
      /(\b["']?(?:authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|private[_-]?key|secret[_-]?key|[\w-]*(?:token|secret|password)|[\w-]+[_-]key)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n"}]+)/giu,
      "$1[redacted]",
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/giu, "$1[redacted]");
}

/** Clip long text for model state, marking the cut. */
export const clip = (text: string, limit = MAX_TEXT): string =>
  text.length <= limit ? text : `${text.slice(0, limit)} … [clipped]`;

/**
 * Remove fenced code blocks (```/~~~) before text leaves the machine: raw code
 * never goes into Jev state. Inline code and prose are kept.
 */
export function stripFencedCode(text: string): string {
  const kept: Array<string> = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (!inFence && /^\s*(?:`{3,}|~{3,})/u.test(line)) {
      inFence = true;
      kept.push("[code]");
      continue;
    }
    if (inFence) {
      if (/^\s*(?:`{3,}|~{3,})\s*$/u.test(line)) inFence = false;
      continue;
    }
    kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
