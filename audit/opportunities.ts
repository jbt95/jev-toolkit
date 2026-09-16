import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { matchQuantitativeClaim } from "../core/detector.ts";
import { Harness, type JevEvent } from "../core/schema.ts";

export class AuditError extends Data.TaggedError("AuditError")<{ readonly source: string }> {}

export const RawOpportunity = Schema.Struct({
  harness: Harness,
  sessionID: Schema.String,
  source: Schema.Literals(["assistant_message"]),
  pattern: Schema.String,
  matchedText: Schema.String,
});
export type RawOpportunity = Schema.Schema.Type<typeof RawOpportunity>;

export interface CorrelatedOpportunity extends RawOpportunity {
  readonly matched: boolean;
}

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

const OpencodeMessage = Schema.Struct({ content: Schema.Array(ContentItem) });
const decodeOpencodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(OpencodeMessage));

const OpencodeRow = Schema.Struct({ session_id: Schema.String, data: Schema.String });
const decodeRow = Schema.decodeUnknownOption(OpencodeRow);

const claimsFromText = (
  harness: RawOpportunity["harness"],
  sessionID: string,
  text: string,
): ReadonlyArray<RawOpportunity> =>
  matchQuantitativeClaim(text).map((match) => ({
    harness,
    sessionID,
    source: "assistant_message",
    pattern: match.pattern,
    matchedText: match.matched,
  }));

const listJsonl = async (root: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(root, { recursive: true });
  return entries.filter((entry) => entry.endsWith(".jsonl")).map((entry) => join(root, entry));
};

const textOf = (content: ReadonlyArray<{ readonly text?: string }>): string =>
  content.flatMap((item) => (item.text === undefined ? [] : [item.text])).join("\n");

export function extractOpencode(
  dbPath: string,
  sinceIso: string,
): Effect.Effect<ReadonlyArray<RawOpportunity>, AuditError> {
  return Effect.try({
    try: () => {
      if (!existsSync(dbPath)) return [];
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const sinceMs = Date.parse(sinceIso);
        const rows = db
          .prepare(
            "SELECT session_id, data FROM session_message WHERE type = 'assistant' AND time_created >= ?",
          )
          .all(sinceMs);
        const opportunities: Array<RawOpportunity> = [];
        for (const row of rows) {
          const decodedRow = decodeRow(row);
          if (Option.isNone(decodedRow)) continue;
          const decoded = decodeOpencodeMessage(decodedRow.value.data);
          if (Option.isNone(decoded)) continue;
          opportunities.push(
            ...claimsFromText(
              "opencode2",
              decodedRow.value.session_id,
              textOf(decoded.value.content),
            ),
          );
        }
        return opportunities;
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
): Effect.Effect<ReadonlyArray<RawOpportunity>, AuditError> {
  return Effect.tryPromise({
    try: async () => {
      const files = await listJsonl(root);
      const opportunities: Array<RawOpportunity> = [];
      for (const file of files) {
        const sessionID = basename(file, ".jsonl");
        const raw = await readFile(file, "utf8");
        for (const line of raw.split("\n")) {
          if (line.trim().length === 0) continue;
          const decoded = decodeClaudeEntry(line);
          if (Option.isNone(decoded)) continue;
          const entry = decoded.value;
          if (entry.type !== "assistant" || entry.message === undefined) continue;
          if (entry.timestamp !== undefined && entry.timestamp < sinceIso) continue;
          opportunities.push(
            ...claimsFromText("claude-code", sessionID, textOf(entry.message.content)),
          );
        }
      }
      return opportunities;
    },
    catch: () => new AuditError({ source: "claude-code" }),
  });
}

export function extractPiOmp(
  roots: ReadonlyArray<PiOmpRoot>,
  sinceIso: string,
): Effect.Effect<ReadonlyArray<RawOpportunity>, AuditError> {
  return Effect.gen(function* () {
    const opportunities: Array<RawOpportunity> = [];
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
          if (entry.type === "session" && entry.id !== undefined) sessionID = entry.id;
          if (entry.type !== "message" || entry.message === undefined) continue;
          if (entry.message.role !== "assistant") continue;
          if (entry.timestamp !== undefined && entry.timestamp < sinceIso) continue;
          opportunities.push(...claimsFromText(harness, sessionID, textOf(entry.message.content)));
        }
      }
    }
    return opportunities;
  });
}

/** An opportunity is matched when the same harness + session produced a call event. */
export function correlate(
  opportunities: ReadonlyArray<RawOpportunity>,
  events: ReadonlyArray<JevEvent>,
): ReadonlyArray<CorrelatedOpportunity> {
  const callSessions = new Set<string>();
  for (const event of events) {
    if (event._tag === "call" && event.sessionID !== undefined) {
      callSessions.add(`${event.harness}|${event.sessionID}`);
    }
  }
  return opportunities.map((opportunity) => ({
    ...opportunity,
    matched: callSessions.has(`${opportunity.harness}|${opportunity.sessionID}`),
  }));
}
