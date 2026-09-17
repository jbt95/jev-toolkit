import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Harness } from "../core/schema.ts";
import { clip, redact } from "../core/text.ts";

export class SessionAuditError extends Data.TaggedError("SessionAuditError")<{
  readonly source: string;
}> {}

export const SessionDigest = Schema.Struct({
  harness: Harness,
  sessionID: Schema.String,
  startedAt: Schema.String,
  userPrompts: Schema.Array(Schema.String),
  assistantTurns: Schema.Number,
  toolCounts: Schema.Record(Schema.String, Schema.Number),
  errorCount: Schema.Number,
  costUsd: Schema.optional(Schema.Number),
});
export type SessionDigest = Schema.Schema.Type<typeof SessionDigest>;

export interface PiOmpRoot {
  readonly harness: "pi" | "omp";
  readonly root: string;
}

const isString = Schema.is(Schema.String);
const prompt = (text: string): string => clip(redact(text)).slice(0, 300);

const ContentItem = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  is_error: Schema.optional(Schema.Boolean),
});

const textOf = (content: ReadonlyArray<{ readonly text?: string }>): string =>
  content.flatMap((item) => Option.toArray(Option.fromUndefinedOr(item.text))).join("\n");

const countTools = (
  content: ReadonlyArray<{
    readonly type?: string;
    readonly name?: string;
    readonly toolName?: string;
  }>,
  toolCounts: Record<string, number>,
): void => {
  for (const item of content) {
    const name = Option.firstSomeOf([
      Option.fromUndefinedOr(item.toolName),
      Option.fromUndefinedOr(item.name),
      Option.fromUndefinedOr(item.type),
    ]).pipe(Option.filter((candidate) => candidate !== "text"));
    if (Option.isNone(name)) continue;
    toolCounts[name.value] = (toolCounts[name.value] ?? 0) + 1;
  }
};

const listJsonl = async (root: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(root, { recursive: true });
  return entries.filter((entry) => entry.endsWith(".jsonl")).map((entry) => join(root, entry));
};

const ClaudeEntry = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({
      role: Schema.optional(Schema.String),
      content: Schema.Union([Schema.String, Schema.Array(ContentItem)]),
    }),
  ),
});
const decodeClaude = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeEntry));

export function digestClaude(
  root: string,
  sinceIso: string,
): Effect.Effect<ReadonlyArray<SessionDigest>, SessionAuditError> {
  return Effect.tryPromise({
    try: async () => {
      const digests: Array<SessionDigest> = [];
      for (const file of await listJsonl(root)) {
        const raw = await readFile(file, "utf8");
        const userPrompts: Array<string> = [];
        const toolCounts: Record<string, number> = {};
        let assistantTurns = 0;
        let errorCount = 0;
        let startedAt = "";
        for (const line of raw.split("\n")) {
          if (line.trim().length === 0) continue;
          const decoded = decodeClaude(line);
          if (Option.isNone(decoded)) continue;
          const entry = decoded.value;
          const firstSeen = Option.fromUndefinedOr(entry.timestamp);
          if (startedAt === "" && Option.isSome(firstSeen)) startedAt = firstSeen.value;
          const tooOld = Option.map(firstSeen, (timestamp) => timestamp < sinceIso).pipe(
            Option.getOrElse(() => false),
          );
          if (tooOld) continue;
          const message = Option.fromUndefinedOr(entry.message);
          if (Option.isNone(message)) continue;
          const content = message.value.content;
          if (entry.type === "assistant") {
            assistantTurns += 1;
            if (!isString(content)) {
              countTools(content, toolCounts);
              for (const item of content) {
                if (item.is_error === true) errorCount += 1;
              }
            }
            continue;
          }
          if (entry.type !== "user") continue;
          if (isString(content)) {
            if (userPrompts.length < 3 && content.trim().length > 0) {
              userPrompts.push(prompt(content));
            }
            continue;
          }
          let toolErrors = 0;
          for (const item of content) {
            if (item.is_error === true) toolErrors += 1;
          }
          errorCount += toolErrors;
          const text = textOf(content);
          if (userPrompts.length < 3 && text.trim().length > 0) userPrompts.push(prompt(text));
        }
        if (assistantTurns === 0 && userPrompts.length === 0) continue;
        digests.push({
          harness: "claude-code",
          sessionID: basename(file, ".jsonl"),
          startedAt,
          userPrompts,
          assistantTurns,
          toolCounts,
          errorCount,
        });
      }
      return digests;
    },
    catch: () => new SessionAuditError({ source: "claude-code" }),
  });
}

const OpencodeSessionRow = Schema.Struct({
  id: Schema.String,
  time_created: Schema.Number,
  cost: Schema.optional(Schema.Number),
});
const decodeSessionRow = Schema.decodeUnknownOption(OpencodeSessionRow);

const OpencodeUser = Schema.Struct({ text: Schema.optional(Schema.String) });
const OpencodeAssistant = Schema.Struct({ content: Schema.Array(ContentItem) });
const decodeOpencodeUser = Schema.decodeUnknownOption(Schema.fromJsonString(OpencodeUser));
const decodeOpencodeAssistant = Schema.decodeUnknownOption(
  Schema.fromJsonString(OpencodeAssistant),
);

export function digestOpencode(
  dbPath: string,
  sinceIso: string,
): Effect.Effect<ReadonlyArray<SessionDigest>, SessionAuditError> {
  return Effect.try({
    try: () => {
      if (!existsSync(dbPath)) return [];
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const sinceMs = Date.parse(sinceIso);
        const rows = db
          .prepare("SELECT id, time_created, cost FROM session_v2 WHERE time_created >= ?")
          .all(sinceMs);
        const digests: Array<SessionDigest> = [];
        for (const row of rows) {
          const decodedRow = decodeSessionRow(row);
          if (Option.isNone(decodedRow)) continue;
          const { id, time_created, cost } = decodedRow.value;
          const messages = db
            .prepare("SELECT type, data FROM session_message WHERE session_id = ?")
            .all(id);
          const userPrompts: Array<string> = [];
          const toolCounts: Record<string, number> = {};
          let assistantTurns = 0;
          let errorCount = 0;
          for (const message of messages) {
            const messageType = message["type"];
            const data = message["data"];
            if (!isString(data)) continue;
            if (messageType === "user") {
              const decoded = decodeOpencodeUser(data);
              const text = Option.flatMap(decoded, (user) => Option.fromUndefinedOr(user.text));
              if (Option.isSome(text)) {
                if (userPrompts.length < 3 && text.value.trim().length > 0) {
                  userPrompts.push(prompt(text.value));
                }
              }
              continue;
            }
            if (messageType !== "assistant") continue;
            const decoded = decodeOpencodeAssistant(data);
            if (Option.isNone(decoded)) continue;
            assistantTurns += 1;
            countTools(decoded.value.content, toolCounts);
          }
          if (assistantTurns === 0 && userPrompts.length === 0) continue;
          const digest: SessionDigest = {
            harness: "opencode2",
            sessionID: id,
            startedAt: new Date(time_created).toISOString(),
            userPrompts,
            assistantTurns,
            toolCounts,
            errorCount,
          };
          digests.push(
            Option.fromUndefinedOr(cost).pipe(
              Option.match({
                onNone: () => digest,
                onSome: (costUsd) => ({ ...digest, costUsd }),
              }),
            ),
          );
        }
        return digests;
      } finally {
        db.close();
      }
    },
    catch: () => new SessionAuditError({ source: "opencode2" }),
  });
}

const PiEntry = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({
      role: Schema.optional(Schema.String),
      content: Schema.Array(ContentItem),
    }),
  ),
});
const decodePiEntry = Schema.decodeUnknownOption(Schema.fromJsonString(PiEntry));

export function digestPiOmp(
  roots: ReadonlyArray<PiOmpRoot>,
  sinceIso: string,
): Effect.Effect<ReadonlyArray<SessionDigest>, SessionAuditError> {
  return Effect.gen(function* () {
    const digests: Array<SessionDigest> = [];
    for (const { harness, root } of roots) {
      const files = yield* Effect.tryPromise({
        try: () => listJsonl(root),
        catch: () => new SessionAuditError({ source: harness }),
      }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const file of files) {
        const raw = yield* Effect.tryPromise({
          try: () => readFile(file, "utf8"),
          catch: () => new SessionAuditError({ source: harness }),
        }).pipe(Effect.orElseSucceed(() => ""));
        const userPrompts: Array<string> = [];
        const toolCounts: Record<string, number> = {};
        let sessionID = basename(file, ".jsonl");
        let startedAt = "";
        let assistantTurns = 0;
        let errorCount = 0;
        for (const line of raw.split("\n")) {
          if (line.trim().length === 0) continue;
          const decoded = decodePiEntry(line);
          if (Option.isNone(decoded)) continue;
          const entry = decoded.value;
          const session = Option.fromUndefinedOr(entry.id);
          if (entry.type === "session" && Option.isSome(session)) sessionID = session.value;
          const firstSeen = Option.fromUndefinedOr(entry.timestamp);
          if (startedAt === "" && Option.isSome(firstSeen)) startedAt = firstSeen.value;
          const tooOld = Option.map(firstSeen, (timestamp) => timestamp < sinceIso).pipe(
            Option.getOrElse(() => false),
          );
          if (tooOld) continue;
          const message = Option.fromUndefinedOr(entry.message);
          if (Option.isNone(message)) continue;
          if (message.value.role === "assistant") {
            assistantTurns += 1;
            countTools(message.value.content, toolCounts);
            for (const item of message.value.content) {
              if (item.is_error === true) errorCount += 1;
            }
            continue;
          }
          if (message.value.role !== "user") continue;
          const text = textOf(message.value.content);
          if (userPrompts.length < 3 && text.trim().length > 0) userPrompts.push(prompt(text));
        }
        if (assistantTurns === 0 && userPrompts.length === 0) continue;
        digests.push({
          harness,
          sessionID,
          startedAt,
          userPrompts,
          assistantTurns,
          toolCounts,
          errorCount,
        });
      }
    }
    return digests;
  });
}
