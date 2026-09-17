import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/**
 * Claude Code transcript parsing: pull the readable error text out of
 * tool-result entries marked `is_error`, newest first.
 */
const TranscriptContent = Schema.Struct({
  type: Schema.String,
  is_error: Schema.optional(Schema.Boolean),
  content: Schema.optional(
    Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
    ]),
  ),
});

const TranscriptEntry = Schema.Struct({
  type: Schema.String,
  message: Schema.optional(
    Schema.Struct({
      content: Schema.Array(TranscriptContent),
    }),
  ),
});
const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptEntry));

const isString = Predicate.isString;
const isTextArray = Schema.is(
  Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
);

const itemText = (item: { readonly content?: unknown }): string => {
  const content = item.content;
  if (isString(content)) return content;
  if (isTextArray(content)) {
    return content.flatMap((part) => Option.toArray(Option.fromUndefinedOr(part.text))).join("\n");
  }
  return "";
};

const MAX_CANDIDATES = 5;
const MAX_LINES = 40;

export function transcriptFailureCandidates(raw: string): ReadonlyArray<string> {
  const candidates: Array<string> = [];
  const lines = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-MAX_LINES)
    .reverse();
  for (const line of lines) {
    const decoded = decodeEntry(line);
    if (Option.isNone(decoded)) continue;
    const content = decoded.value.message?.content ?? [];
    for (const item of content) {
      if (item.is_error !== true) continue;
      const text = itemText(item).trim();
      if (text.length > 0 && !candidates.includes(text)) candidates.push(text);
      if (candidates.length >= MAX_CANDIDATES) return candidates;
    }
  }
  if (candidates.length > 0) return candidates;
  // Fallback for transcript shapes the decoder does not recognize.
  for (const line of lines) {
    if (line.includes('"is_error":true') || line.includes('"is_error": true')) return [line];
  }
  return [];
}
