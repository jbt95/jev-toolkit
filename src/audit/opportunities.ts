import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { matchQuantitativeClaim } from "../core/detector.ts";
import { Harness, type ClaimKind } from "../core/schema.ts";
import { clip, redact, stripFencedCode } from "../core/text.ts";

export class AuditError extends Data.TaggedError("AuditError")<{ readonly source: string }> {}

/** One assistant message (or user prompt) reduced to the prose Jev may see. */
export const RawMessage = Schema.Struct({
  harness: Harness,
  sessionID: Schema.String,
  text: Schema.String,
});
export type RawMessage = Schema.Schema.Type<typeof RawMessage>;

export interface DetectedOpportunity {
  readonly harness: RawMessage["harness"];
  readonly sessionID: string;
  readonly pattern: ClaimKind;
  readonly excerpt: string;
}

/** An opportunity is matched when a session question actually addressed the claim. */
export interface CorrelatedOpportunity extends DetectedOpportunity {
  readonly matched: boolean;
}

/**
 * The regex is no longer the detector. It only quotes the span for a kind Jev
 * already routed, falling back to a short excerpt when it cannot find one.
 */
export const toDetectedOpportunity = (
  message: RawMessage,
  kind: ClaimKind,
): DetectedOpportunity => {
  const excerpt = Option.fromUndefinedOr(
    matchQuantitativeClaim(message.text).find((match) => match.pattern === kind),
  ).pipe(
    Option.map((span) => span.matched),
    Option.getOrElse(() => message.text.slice(0, 120)),
  );
  return {
    harness: message.harness,
    sessionID: message.sessionID,
    pattern: kind,
    excerpt,
  };
};

const messageFromText = (
  harness: RawMessage["harness"],
  sessionID: string,
  text: string,
): Option.Option<RawMessage> => {
  const prose = stripFencedCode(text);
  if (prose.trim().length === 0) return Option.none();
  return Option.some({ harness, sessionID, text: clip(redact(prose), 1000) });
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

const PiEntry = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({ role: Schema.optional(Schema.String), content: Schema.Array(ContentItem) }),
  ),
});
const decodePiEntry = Schema.decodeUnknownOption(Schema.fromJsonString(PiEntry));

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

const OpencodeRow = Schema.Struct({ session_id: Schema.String, data: Schema.String });
const decodeRow = Schema.decodeUnknownOption(OpencodeRow);

const listJsonl = async (root: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(root, { recursive: true });
  return entries.filter((entry) => entry.endsWith(".jsonl")).map((entry) => join(root, entry));
};

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
            "SELECT session_id, data FROM session_message WHERE type = ? AND time_created >= ?",
          )
          .all(messageType, sinceMs);
        const messages: Array<RawMessage> = [];
        for (const row of rows) {
          const decodedRow = decodeRow(row);
          if (Option.isNone(decodedRow)) continue;
          const text = opencodeText(decodedRow.value.data);
          if (Option.isNone(text)) continue;
          messages.push(
            ...Option.toArray(
              messageFromText("opencode2", decodedRow.value.session_id, text.value),
            ),
          );
        }
        return messages;
      } finally {
        db.close();
      }
    },
    catch: () => new AuditError({ source: "opencode2" }),
  });
}

export function extractClaude(
  root: string,
  sinceIso: string,
): Effect.Effect<ReadonlyArray<RawMessage>, AuditError> {
  return Effect.tryPromise({
    try: async () => {
      const files = await listJsonl(root);
      const messages: Array<RawMessage> = [];
      for (const file of files) {
        const sessionID = basename(file, ".jsonl");
        const raw = await readFile(file, "utf8");
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
              messageFromText("claude-code", sessionID, textOf(message.value.content)),
            ),
          );
        }
      }
      return messages;
    },
    catch: () => new AuditError({ source: "claude-code" }),
  });
}

export function extractPiOmp(
  roots: ReadonlyArray<PiOmpRoot>,
  sinceIso: string,
): Effect.Effect<ReadonlyArray<RawMessage>, AuditError> {
  return Effect.gen(function* () {
    const messages: Array<RawMessage> = [];
    for (const { harness, root } of roots) {
      const files = yield* Effect.tryPromise({
        try: () => listJsonl(root),
        catch: () => new AuditError({ source: harness }),
      }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const file of files) {
        const raw = yield* Effect.tryPromise({
          try: () => readFile(file, "utf8"),
          catch: () => new AuditError({ source: harness }),
        }).pipe(Effect.orElseSucceed(() => ""));
        let sessionID = basename(file, ".jsonl");
        for (const line of raw.split("\n")) {
          if (line.trim().length === 0) continue;
          const decoded = decodePiEntry(line);
          if (Option.isNone(decoded)) continue;
          const entry = decoded.value;
          const session = Option.fromUndefinedOr(entry.id);
          if (entry.type === "session" && Option.isSome(session)) sessionID = session.value;
          const message = Option.fromUndefinedOr(entry.message);
          if (entry.type !== "message" || Option.isNone(message)) continue;
          if (message.value.role !== "assistant") continue;
          const tooOld = Option.fromUndefinedOr(entry.timestamp).pipe(
            Option.map((timestamp) => timestamp < sinceIso),
            Option.getOrElse(() => false),
          );
          if (tooOld) continue;
          messages.push(
            ...Option.toArray(messageFromText(harness, sessionID, textOf(message.value.content))),
          );
        }
      }
    }
    return messages;
  });
}
