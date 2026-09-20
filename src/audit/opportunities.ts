import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { basename } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { matchQuantitativeClaim } from "../core/detector.ts";
import { Harness, type ClaimKind } from "../core/schema.ts";
import { clip, redact, stripFencedCode } from "../core/text.ts";
import {
  assistantMessages,
  listJsonlFiles,
  parsePiOmpLines,
  readSessionRoot,
} from "./session-files.ts";

export class AuditError extends Data.TaggedError("AuditError")<{ readonly source: string }> {}

/** Which surface a raw message came from: a request or a published claim. */
export const MessageSource = Schema.Literals(["user_prompt", "assistant_message"]);
export type MessageSource = Schema.Schema.Type<typeof MessageSource>;

/** One assistant message (or user prompt) reduced to the prose Jev may see. */
export const RawMessage = Schema.Struct({
  harness: Harness,
  sessionID: Schema.String,
  source: MessageSource,
  /** Message timestamp; with the other fields it identifies one detection, so
   * repeated audits of the same window cannot double-count a claim. */
  ts: Schema.String,
  text: Schema.String,
});
export type RawMessage = Schema.Schema.Type<typeof RawMessage>;

export interface DetectedOpportunity {
  readonly harness: RawMessage["harness"];
  readonly sessionID: string;
  readonly source: MessageSource;
  readonly ts: string;
  readonly pattern: ClaimKind;
  readonly excerpt: string;
  /** Sanitized window around the claim; the alignment prompt needs context. */
  readonly context: string;
}

/** An opportunity is matched when a session question actually addressed the claim. */
export interface CorrelatedOpportunity extends DetectedOpportunity {
  readonly matched: boolean;
}

/**
 * The regex is no longer the detector. It only quotes the span for a kind Jev
 * already routed, falling back to a short excerpt when it cannot find one. A
 * second, wider window is carried for alignment: judging a claim from a bare
 * span ("33%") tells the model nothing.
 */
const CONTEXT_RADIUS = 120;

const windowAround = (text: string, span: string): string => {
  const at = span.length === 0 ? -1 : text.indexOf(span);
  if (at < 0) return text.slice(0, CONTEXT_RADIUS * 2);
  const start = Math.max(0, at - CONTEXT_RADIUS);
  const end = Math.min(text.length, at + span.length + CONTEXT_RADIUS);
  return text.slice(start, end);
};

export const toDetectedOpportunity = (
  message: RawMessage,
  kind: ClaimKind,
): DetectedOpportunity => {
  const span = Option.fromUndefinedOr(
    matchQuantitativeClaim(message.text).find((match) => match.pattern === kind),
  ).pipe(Option.map((match) => match.matched));
  const excerpt = Option.getOrElse(span, () => message.text.slice(0, 120));
  return {
    harness: message.harness,
    sessionID: message.sessionID,
    source: message.source,
    ts: message.ts,
    pattern: kind,
    excerpt,
    context: windowAround(
      message.text,
      Option.getOrElse(span, () => ""),
    ),
  };
};

const messageFromText = (
  harness: RawMessage["harness"],
  sessionID: string,
  source: MessageSource,
  ts: string,
  text: string,
): Option.Option<RawMessage> => {
  const prose = stripFencedCode(text);
  if (prose.trim().length === 0) return Option.none();
  return Option.some({ harness, sessionID, source, ts, text: clip(redact(prose), 1000) });
};

export interface PiOmpRoot {
  readonly harness: "pi" | "omp";
  readonly root: string;
}

const ContentItem = Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) });

const ClaudeEntry = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({ role: Schema.optional(Schema.String), content: Schema.Array(ContentItem) }),
  ),
});
const decodeClaudeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeEntry));

const OpencodeContentMessage = Schema.Struct({ content: Schema.Array(ContentItem) });
const OpencodeTextMessage = Schema.Struct({ text: Schema.String });
const decodeOpencodeContent = Schema.decodeUnknownOption(
  Schema.fromJsonString(OpencodeContentMessage),
);
const decodeOpencodeText = Schema.decodeUnknownOption(Schema.fromJsonString(OpencodeTextMessage));

/** Assistant rows carry `content` parts; user rows carry a top-level `text`. */
const opencodeText = (data: string): Option.Option<string> =>
  decodeOpencodeContent(data).pipe(
    Option.map((content) => textOf(content.content)),
    Option.orElse(() => Option.map(decodeOpencodeText(data), (plain) => plain.text)),
  );

const OpencodeRow = Schema.Struct({
  session_id: Schema.String,
  time_created: Schema.Number,
  data: Schema.String,
});
const decodeRow = Schema.decodeUnknownOption(OpencodeRow);

const textOf = (content: ReadonlyArray<{ readonly text?: string }>): string =>
  content.flatMap((item) => Option.toArray(Option.fromUndefinedOr(item.text))).join("\n");

export function extractOpencode(
  dbPath: string,
  sinceIso: string,
  messageType: "assistant" | "user",
): Effect.Effect<ReadonlyArray<RawMessage>, AuditError> {
  return Effect.try({
    try: () => {
      if (!existsSync(dbPath)) return [];
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const sinceMs = Date.parse(sinceIso);
        const rows = db
          .prepare(
            "SELECT session_id, time_created, data FROM session_message " +
              "WHERE type = ? AND time_created >= ?",
          )
          .all(messageType, sinceMs);
        const messages: Array<RawMessage> = [];
        const source: MessageSource = messageType === "user" ? "user_prompt" : "assistant_message";
        for (const row of rows) {
          const decodedRow = decodeRow(row);
          if (Option.isNone(decodedRow)) continue;
          const text = opencodeText(decodedRow.value.data);
          if (Option.isNone(text)) continue;
          messages.push(
            ...Option.toArray(
              messageFromText(
                "opencode",
                decodedRow.value.session_id,
                source,
                new Date(decodedRow.value.time_created).toISOString(),
                text.value,
              ),
            ),
          );
        }
        return messages;
      } finally {
        db.close();
      }
    },
    catch: () => new AuditError({ source: "opencode" }),
  });
}

const claudeMessages = (
  sessionID: string,
  raw: string,
  sinceIso: string,
): ReadonlyArray<RawMessage> => {
  const messages: Array<RawMessage> = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const decoded = decodeClaudeEntry(line);
    if (Option.isNone(decoded)) continue;
    const entry = decoded.value;
    const message = Option.fromUndefinedOr(entry.message);
    if (entry.type !== "assistant" || Option.isNone(message)) continue;
    const tooOld = Option.fromUndefinedOr(entry.timestamp).pipe(
      Option.map((timestamp) => timestamp < sinceIso),
      Option.getOrElse(() => false),
    );
    if (tooOld) continue;
    messages.push(
      ...Option.toArray(
        messageFromText(
          "claude-code",
          sessionID,
          "assistant_message",
          Option.getOrElse(Option.fromUndefinedOr(entry.timestamp), () => ""),
          textOf(message.value.content),
        ),
      ),
    );
  }
  return messages;
};

export function extractClaude(
  root: string,
  sinceIso: string,
): Effect.Effect<ReadonlyArray<RawMessage>, AuditError> {
  return Effect.tryPromise({
    try: async () => {
      const messages: Array<RawMessage> = [];
      for (const file of await listJsonlFiles(root)) {
        const raw = await readFile(file, "utf8");
        messages.push(...claudeMessages(basename(file, ".jsonl"), raw, sinceIso));
      }
      return messages;
    },
    catch: () => new AuditError({ source: "claude-code" }),
  });
}

const piOmpMessages = (
  harness: "pi" | "omp",
  file: string,
  raw: string,
  sinceIso: string,
): ReadonlyArray<RawMessage> => {
  const messages: Array<RawMessage> = [];
  for (const turn of assistantMessages(parsePiOmpLines(file, raw), sinceIso)) {
    messages.push(
      ...Option.toArray(
        messageFromText(
          harness,
          turn.sessionID,
          "assistant_message",
          turn.timestamp,
          textOf(turn.message.content),
        ),
      ),
    );
  }
  return messages;
};

export function extractPiOmp(
  roots: ReadonlyArray<PiOmpRoot>,
  sinceIso: string,
): Effect.Effect<ReadonlyArray<RawMessage>, AuditError> {
  return Effect.gen(function* () {
    const messages: Array<RawMessage> = [];
    for (const { harness, root } of roots) {
      const sessions = yield* readSessionRoot(root, (source) => new AuditError({ source }));
      for (const { file, raw } of sessions) {
        messages.push(...piOmpMessages(harness, file, raw, sinceIso));
      }
    }
    return messages;
  });
}
