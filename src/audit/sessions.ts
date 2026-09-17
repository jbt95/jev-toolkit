import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isNotFoundError } from "../core/fs-errors.ts";
import { Harness } from "../core/schema.ts";
import { clip, redact, stripFencedCode } from "../core/text.ts";

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

const isString = Predicate.isString;
const prompt = (text: string): string => clip(stripFencedCode(redact(text))).slice(0, 300);

/** Per-session digest state, shared by every harness reader. */
interface DigestDraft {
  userPrompts: Array<string>;
  toolCounts: Record<string, number>;
  assistantTurns: number;
  errorCount: number;
  startedAt: string;
}

const newDraft = (): DigestDraft => ({
  userPrompts: [],
  toolCounts: {},
  assistantTurns: 0,
  errorCount: 0,
  startedAt: "",
});

const recordPrompt = (draft: DigestDraft, text: string): void => {
  if (draft.userPrompts.length >= 3 || text.trim().length === 0) return;
  draft.userPrompts.push(prompt(text));
};

const recordStartedAt = (draft: DigestDraft, timestamp: string | undefined): void => {
  if (draft.startedAt !== "") return;
  const seen = Option.fromUndefinedOr(timestamp);
  if (Option.isSome(seen)) draft.startedAt = seen.value;
};

const isTooOld = (timestamp: string | undefined, sinceIso: string): boolean =>
  Option.fromUndefinedOr(timestamp).pipe(
    Option.map((value) => value < sinceIso),
    Option.getOrElse(() => false),
  );

const draftDigest = (
  harness: Harness,
  sessionID: string,
  draft: DigestDraft,
  costUsd?: number,
): Option.Option<SessionDigest> => {
  if (draft.assistantTurns === 0 && draft.userPrompts.length === 0) return Option.none();
  const base: SessionDigest = {
    harness,
    sessionID,
    startedAt: draft.startedAt,
    userPrompts: draft.userPrompts,
    assistantTurns: draft.assistantTurns,
    toolCounts: draft.toolCounts,
    errorCount: draft.errorCount,
  };
  return Option.some(
    Option.fromUndefinedOr(costUsd).pipe(
      Option.match({
        onNone: () => base,
        onSome: (cost) => ({ ...base, costUsd: cost }),
      }),
    ),
  );
};

const ContentItem = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  is_error: Schema.optional(Schema.Boolean),
  state: Schema.optional(Schema.Struct({ status: Schema.optional(Schema.String) })),
});

const textOf = (content: ReadonlyArray<{ readonly text?: string }>): string =>
  content.flatMap((item) => Option.toArray(Option.fromUndefinedOr(item.text))).join("\n");

/** Count only actual tool-call parts: thinking, text, and image parts are not tools. */
const countTools = (
  content: ReadonlyArray<{
    readonly type?: string;
    readonly name?: string;
    readonly toolName?: string;
  }>,
  toolCounts: Record<string, number>,
  toolPartType: string,
): void => {
  for (const item of content) {
    if (item.type !== toolPartType) continue;
    const name = Option.firstSomeOf([
      Option.fromUndefinedOr(item.toolName),
      Option.fromUndefinedOr(item.name),
    ]);
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
type ClaudeEntry = Schema.Schema.Type<typeof ClaudeEntry>;
type ClaudeContent = string | ReadonlyArray<Schema.Schema.Type<typeof ContentItem>>;
const decodeClaude = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeEntry));

const accumulateClaudeUser = (draft: DigestDraft, content: ClaudeContent): void => {
  if (isString(content)) {
    recordPrompt(draft, content);
    return;
  }
  for (const item of content) {
    if (item.is_error === true) draft.errorCount += 1;
  }
  recordPrompt(draft, textOf(content));
};

const accumulateClaude = (draft: DigestDraft, entry: ClaudeEntry, sinceIso: string): void => {
  recordStartedAt(draft, entry.timestamp);
  if (isTooOld(entry.timestamp, sinceIso)) return;
  const message = Option.fromUndefinedOr(entry.message);
  if (Option.isNone(message)) return;
  const content = message.value.content;
  if (entry.type === "assistant") {
    draft.assistantTurns += 1;
    if (!isString(content)) countTools(content, draft.toolCounts, "tool_use");
    if (!isString(content)) {
      for (const item of content) {
        if (item.is_error === true) draft.errorCount += 1;
      }
    }
    return;
  }
  if (entry.type !== "user") return;
  accumulateClaudeUser(draft, content);
};

export function digestClaude(
  root: string,
  sinceIso: string,
): Effect.Effect<ReadonlyArray<SessionDigest>, SessionAuditError> {
  return Effect.tryPromise({
    try: async () => {
      const digests: Array<SessionDigest> = [];
      for (const file of await listJsonl(root)) {
        const raw = await readFile(file, "utf8");
        const draft = newDraft();
        for (const line of raw.split("\n")) {
          if (line.trim().length === 0) continue;
          const decoded = decodeClaude(line);
          if (Option.isNone(decoded)) continue;
          accumulateClaude(draft, decoded.value, sinceIso);
        }
        const digest = draftDigest("claude-code", basename(file, ".jsonl"), draft);
        if (Option.isSome(digest)) digests.push(digest.value);
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
type OpencodeSessionRow = Schema.Schema.Type<typeof OpencodeSessionRow>;
const decodeSessionRow = Schema.decodeUnknownOption(OpencodeSessionRow);

const OpencodeUser = Schema.Struct({ text: Schema.optional(Schema.String) });
const OpencodeAssistant = Schema.Struct({ content: Schema.Array(ContentItem) });
const decodeOpencodeUser = Schema.decodeUnknownOption(Schema.fromJsonString(OpencodeUser));
const decodeOpencodeAssistant = Schema.decodeUnknownOption(
  Schema.fromJsonString(OpencodeAssistant),
);

const accumulateOpencodeUser = (draft: DigestDraft, data: string): void => {
  const decoded = decodeOpencodeUser(data);
  const text = Option.flatMap(decoded, (user) => Option.fromUndefinedOr(user.text));
  if (Option.isSome(text)) recordPrompt(draft, text.value);
};

const accumulateOpencodeAssistant = (draft: DigestDraft, data: string): void => {
  const decoded = decodeOpencodeAssistant(data);
  if (Option.isNone(decoded)) return;
  draft.assistantTurns += 1;
  countTools(decoded.value.content, draft.toolCounts, "tool");
  for (const item of decoded.value.content) {
    if (item.type === "tool" && item.state?.status === "error") draft.errorCount += 1;
  }
};

const digestOpencodeSession = (
  db: DatabaseSync,
  session: OpencodeSessionRow,
): Option.Option<SessionDigest> => {
  const draft = newDraft();
  const messages = db
    .prepare("SELECT type, data FROM session_message WHERE session_id = ?")
    .all(session.id);
  for (const message of messages) {
    const messageType = message["type"];
    const data = message["data"];
    if (!isString(data)) continue;
    if (messageType === "user") {
      accumulateOpencodeUser(draft, data);
      continue;
    }
    if (messageType !== "assistant") continue;
    accumulateOpencodeAssistant(draft, data);
  }
  draft.startedAt = new Date(session.time_created).toISOString();
  return draftDigest("opencode2", session.id, draft, session.cost);
};

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
          const digest = digestOpencodeSession(db, decodedRow.value);
          if (Option.isSome(digest)) digests.push(digest.value);
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
type PiEntry = Schema.Schema.Type<typeof PiEntry>;
const decodePiEntry = Schema.decodeUnknownOption(Schema.fromJsonString(PiEntry));

const accumulatePi = (draft: DigestDraft, entry: PiEntry, sinceIso: string): void => {
  recordStartedAt(draft, entry.timestamp);
  if (isTooOld(entry.timestamp, sinceIso)) return;
  const message = Option.fromUndefinedOr(entry.message);
  if (entry.type !== "message" || Option.isNone(message)) return;
  if (message.value.role === "assistant") {
    draft.assistantTurns += 1;
    countTools(message.value.content, draft.toolCounts, "toolCall");
    for (const item of message.value.content) {
      if (item.is_error === true) draft.errorCount += 1;
    }
    return;
  }
  if (message.value.role !== "user") return;
  recordPrompt(draft, textOf(message.value.content));
};

const digestPiOmpText = (
  harness: "pi" | "omp",
  file: string,
  raw: string,
  sinceIso: string,
): Option.Option<SessionDigest> => {
  const draft = newDraft();
  let sessionID = basename(file, ".jsonl");
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const decoded = decodePiEntry(line);
    if (Option.isNone(decoded)) continue;
    const entry = decoded.value;
    const session = Option.fromUndefinedOr(entry.id);
    if (entry.type === "session" && Option.isSome(session)) sessionID = session.value;
    accumulatePi(draft, entry, sinceIso);
  }
  return draftDigest(harness, sessionID, draft);
};

export function digestPiOmp(
  roots: ReadonlyArray<PiOmpRoot>,
  sinceIso: string,
): Effect.Effect<ReadonlyArray<SessionDigest>, SessionAuditError> {
  return Effect.gen(function* () {
    const digests: Array<SessionDigest> = [];
    for (const { harness, root } of roots) {
      const files = yield* Effect.tryPromise({
        try: () => listJsonl(root),
        catch: (cause) => cause,
      }).pipe(
        // A harness that was never used has no sessions dir; other failures must surface.
        Effect.catchIf(isNotFoundError, () => Effect.succeed([])),
        Effect.mapError(() => new SessionAuditError({ source: harness })),
      );
      for (const file of files) {
        const raw = yield* Effect.tryPromise({
          try: () => readFile(file, "utf8"),
          catch: (cause) => cause,
        }).pipe(
          // A file that vanished mid-scan contributes nothing; keep other errors loud.
          Effect.catchIf(isNotFoundError, () => Effect.succeed("")),
          Effect.mapError(() => new SessionAuditError({ source: harness })),
        );
        const digest = digestPiOmpText(harness, file, raw, sinceIso);
        if (Option.isSome(digest)) digests.push(digest.value);
      }
    }
    return digests;
  });
}
