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
