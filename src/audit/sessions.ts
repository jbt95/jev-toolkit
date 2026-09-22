import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Harness, SessionTokens } from "../core/schema.ts";
import {
  parsePiOmpLines,
  readSessionRoot,
  sessionIDFromFile,
  type PiOmpEntry,
} from "./session-files.ts";
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
  /** Tool results the harness flagged as errors. */
  errorCount: Schema.Number,
  /** Summed model usage across the session; absent when the harness reports none. */
  tokens: Schema.optional(SessionTokens),
  /** Turn endings by stop reason; `length`/`error`/`aborted` surface truncation. */
  stopReasons: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  costUsd: Schema.optional(Schema.Number),
  /** Subagent sessions record the session that spawned them. */
  parentSessionID: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  firstToolAt: Schema.optional(Schema.String),
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
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** True once the harness reported model usage for any turn. */
  usageSeen: boolean;
  costUsd: number;
  stopReasons: Record<string, number>;
  parentSessionID: string;
  startedAt: string;
  endedAt: string;
  firstToolAt: string;
}

const newDraft = (): DigestDraft => ({
  userPrompts: [],
  toolCounts: {},
  assistantTurns: 0,
  errorCount: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  usageSeen: false,
  costUsd: 0,
  stopReasons: {},
  parentSessionID: "",
  startedAt: "",
  endedAt: "",
  firstToolAt: "",
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

const recordEndedAt = (draft: DigestDraft, timestamp: string | undefined): void => {
  const seen = Option.fromUndefinedOr(timestamp);
  if (Option.isNone(seen)) return;
  if (draft.endedAt === "" || seen.value > draft.endedAt) draft.endedAt = seen.value;
};

const recordFirstToolAt = (draft: DigestDraft, timestamp: string | undefined): void => {
  const seen = Option.fromUndefinedOr(timestamp);
  if (Option.isSome(seen) && (draft.firstToolAt === "" || seen.value < draft.firstToolAt)) {
    draft.firstToolAt = seen.value;
  }
};

const isTooOld = (timestamp: string | undefined, sinceIso: string): boolean =>
  Option.fromUndefinedOr(timestamp).pipe(
    Option.map((value) => value < sinceIso),
    Option.getOrElse(() => false),
  );

/** Facts that only some harnesses record; each appears only when observed. */
const recordedFacts = (draft: DigestDraft): Partial<SessionDigest> => ({
  tokens: draft.usageSeen ? { ...draft.tokens } : undefined,
  stopReasons: Object.keys(draft.stopReasons).length > 0 ? draft.stopReasons : undefined,
  parentSessionID: draft.parentSessionID === "" ? undefined : draft.parentSessionID,
});

/** A session-row cost (opencode) beats summed per-turn cost when both exist. */
const preferredCost = (draft: DigestDraft, costUsd: number | undefined): number | undefined => {
  if (costUsd !== undefined && costUsd > 0) return costUsd;
  return draft.usageSeen ? draft.costUsd : undefined;
};

const draftDigest = (
  harness: Harness,
  sessionID: string,
  draft: DigestDraft,
  costUsd?: number,
): Option.Option<SessionDigest> => {
  if (draft.assistantTurns === 0 && draft.userPrompts.length === 0) return Option.none();
  const startedMs = Date.parse(draft.startedAt);
  const endedMs = Date.parse(draft.endedAt);
  const durationMs =
    Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs
      ? endedMs - startedMs
      : undefined;
  return Option.some({
    harness,
    sessionID,
    startedAt: draft.startedAt,
    userPrompts: draft.userPrompts,
    assistantTurns: draft.assistantTurns,
    toolCounts: draft.toolCounts,
    errorCount: draft.errorCount,
    ...recordedFacts(draft),
    costUsd: preferredCost(draft, costUsd),
    endedAt: draft.endedAt === "" ? undefined : draft.endedAt,
    durationMs,
    firstToolAt: draft.firstToolAt === "" ? undefined : draft.firstToolAt,
  });
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
): number => {
  let count = 0;
  for (const item of content) {
    if (item.type !== toolPartType) continue;
    const name = Option.firstSomeOf([
      Option.fromUndefinedOr(item.toolName),
      Option.fromUndefinedOr(item.name),
    ]);
    if (Option.isNone(name)) continue;
    toolCounts[name.value] = (toolCounts[name.value] ?? 0) + 1;
    count += 1;
  }
  return count;
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
  recordEndedAt(draft, entry.timestamp);
  if (entry.type === "assistant") {
    draft.assistantTurns += 1;
    if (!isString(content) && countTools(content, draft.toolCounts, "tool_use") > 0) {
      recordFirstToolAt(draft, entry.timestamp);
    }
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

const accumulateOpencodeAssistant = (draft: DigestDraft, data: string): number => {
  const decoded = decodeOpencodeAssistant(data);
  if (Option.isNone(decoded)) return 0;
  draft.assistantTurns += 1;
  const toolCount = countTools(decoded.value.content, draft.toolCounts, "tool");
  for (const item of decoded.value.content) {
    if (item.type === "tool" && item.state?.status === "error") draft.errorCount += 1;
  }
  return toolCount;
};

const OpencodeMessageRow = Schema.Struct({
  type: Schema.String,
  data: Schema.String,
  time_created: Schema.optional(Schema.Number),
});
const decodeOpencodeMessageRow = Schema.decodeUnknownOption(OpencodeMessageRow);
const decodeTableColumn = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String }));

const digestOpencodeSession = (
  db: DatabaseSync,
  session: OpencodeSessionRow,
): Option.Option<SessionDigest> => {
  const draft = newDraft();
  const hasMessageTime = db
    .prepare("PRAGMA table_info(session_message)")
    .all()
    .some((column) =>
      Option.match(decodeTableColumn(column), {
        onNone: () => false,
        onSome: (decoded) => decoded.name === "time_created",
      }),
    );
  const messages = db
    .prepare(
      hasMessageTime
        ? "SELECT type, data, time_created FROM session_message WHERE session_id = ?"
        : "SELECT type, data FROM session_message WHERE session_id = ?",
    )
    .all(session.id);
  for (const message of messages) {
    const decoded = decodeOpencodeMessageRow(message);
    if (Option.isNone(decoded)) continue;
    const { type: messageType, data, time_created: timeCreated } = decoded.value;
    const timestamp = Option.map(Option.fromUndefinedOr(timeCreated), (value) =>
      new Date(value).toISOString(),
    );
    if (Option.isSome(timestamp)) recordEndedAt(draft, timestamp.value);
    if (messageType === "user") {
      accumulateOpencodeUser(draft, data);
      continue;
    }
    if (messageType !== "assistant") continue;
    if (accumulateOpencodeAssistant(draft, data) > 0 && Option.isSome(timestamp)) {
      recordFirstToolAt(draft, timestamp.value);
    }
  }
  draft.startedAt = new Date(session.time_created).toISOString();
  return draftDigest("opencode", session.id, draft, session.cost);
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
    catch: () => new SessionAuditError({ source: "opencode" }),
  });
}

/** Sum one assistant turn's model usage into the draft. */
const accumulateUsage = (
  draft: DigestDraft,
  usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly cost?: { readonly total: number } | undefined;
  },
): void => {
  draft.usageSeen = true;
  draft.tokens.input += usage.input;
  draft.tokens.output += usage.output;
  draft.tokens.cacheRead += usage.cacheRead;
  draft.tokens.cacheWrite += usage.cacheWrite;
  draft.costUsd += usage.cost?.total ?? 0;
};

type PiMessage = NonNullable<PiOmpEntry["message"]>;

/** Assistant turns carry tools, usage, and the reason the turn ended. */
const accumulateAssistant = (draft: DigestDraft, message: PiMessage): number => {
  draft.assistantTurns += 1;
  const toolCount = countTools(message.content, draft.toolCounts, "toolCall");
  for (const item of message.content) {
    if (item.is_error === true) draft.errorCount += 1;
  }
  const usage = Option.fromUndefinedOr(message.usage);
  if (Option.isSome(usage)) accumulateUsage(draft, usage.value);
  const stopReason = Option.fromUndefinedOr(message.stopReason);
  if (Option.isSome(stopReason)) {
    draft.stopReasons[stopReason.value] = (draft.stopReasons[stopReason.value] ?? 0) + 1;
  }
  return toolCount;
};

/** Tool results report failure on the message, not on a content part. */
const accumulateToolResult = (draft: DigestDraft, message: PiMessage): void => {
  if (message.isError === true) draft.errorCount += 1;
};

const accumulatePi = (draft: DigestDraft, entry: PiOmpEntry, sinceIso: string): void => {
  recordStartedAt(draft, entry.timestamp);
  if (isTooOld(entry.timestamp, sinceIso)) return;
  if (entry.type !== "message") return;
  const message = Option.fromUndefinedOr(entry.message);
  if (Option.isNone(message)) return;
  recordEndedAt(draft, entry.timestamp);
  switch (message.value.role) {
    case "assistant":
      if (accumulateAssistant(draft, message.value) > 0) {
        recordFirstToolAt(draft, entry.timestamp);
      }
      return;
    case "toolResult":
      accumulateToolResult(draft, message.value);
      return;
    case "user":
      recordPrompt(draft, textOf(message.value.content));
      return;
    default:
      return;
  }
};

const digestPiOmpText = (
  harness: "pi" | "omp",
  file: string,
  raw: string,
  sinceIso: string,
): Option.Option<SessionDigest> => {
  const draft = newDraft();
  let sessionID = sessionIDFromFile(file);
  for (const line of parsePiOmpLines(file, raw)) {
    sessionID = line.sessionID;
    const parent = Option.fromUndefinedOr(line.parentSessionID);
    if (Option.isSome(parent)) draft.parentSessionID = parent.value;
    accumulatePi(draft, line.entry, sinceIso);
  }
  return draftDigest(harness, sessionID, draft);
};

export function digestPiOmp(
  roots: ReadonlyArray<PiOmpRoot>,
  sinceIso: string,
): Effect.Effect<ReadonlyArray<SessionDigest>, SessionAuditError> {
  return Effect.gen(function* digestPiOmpProgram() {
    const digests: Array<SessionDigest> = [];
    for (const { harness, root } of roots) {
      const sessions = yield* readSessionRoot(root, (source) => new SessionAuditError({ source }));
      for (const { file, raw } of sessions) {
        const digest = digestPiOmpText(harness, file, raw, sinceIso);
        if (Option.isSome(digest)) digests.push(digest.value);
      }
    }
    return digests;
  });
}
