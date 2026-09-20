import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isNotFoundError } from "../core/fs-errors.ts";

/**
 * One reader for pi/omp session files. The audit extractor, the session digest,
 * and call attribution all walk the same records, so the schema, the session
 * identity rules, and the file listing live here instead of in three copies
 * that drift.
 */

/** Any content part a session may carry; each consumer reads what it needs. */
export const PiOmpPart = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  is_error: Schema.optional(Schema.Boolean),
  state: Schema.optional(Schema.Struct({ status: Schema.optional(Schema.String) })),
  arguments: Schema.optional(
    Schema.Struct({
      path: Schema.optional(Schema.String),
      content: Schema.optional(Schema.String),
      questions: Schema.optional(Schema.Json),
    }),
  ),
});
export type PiOmpPart = Schema.Schema.Type<typeof PiOmpPart>;

export const PiOmpEntry = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  parentSession: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({
      role: Schema.optional(Schema.String),
      content: Schema.Array(PiOmpPart),
      isError: Schema.optional(Schema.Boolean),
      stopReason: Schema.optional(Schema.String),
      usage: Schema.optional(
        Schema.Struct({
          input: Schema.Number,
          output: Schema.Number,
          cacheRead: Schema.Number,
          cacheWrite: Schema.Number,
          cost: Schema.optional(Schema.Struct({ total: Schema.Number })),
        }),
      ),
    }),
  ),
});
export type PiOmpEntry = Schema.Schema.Type<typeof PiOmpEntry>;
export const decodePiOmpEntry = Schema.decodeUnknownOption(Schema.fromJsonString(PiOmpEntry));

/** Session files are named `<timestamp>_<session id>.jsonl`; keep the id. */
export const sessionIDFromFile = (path: string): string => {
  const base = basename(path, ".jsonl");
  const separator = base.indexOf("_");
  return separator < 0 ? base : base.slice(separator + 1);
};

/** One decoded line with the session identity resolved so far in its file. */
export interface PiOmpLine {
  readonly sessionID: string;
  readonly parentSessionID: string | undefined;
  readonly entry: PiOmpEntry;
}

/**
 * Decode one session file in order. The `session` header names the session and
 * its parent; messages inherit both, and a file without a header keeps its
 * filename id. Malformed lines are skipped.
 */
export const parsePiOmpLines = (file: string, raw: string): ReadonlyArray<PiOmpLine> => {
  const lines: Array<PiOmpLine> = [];
  let sessionID = sessionIDFromFile(file);
  let parentSessionID: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const decoded = decodePiOmpEntry(line);
    if (Option.isNone(decoded)) continue;
    const entry = decoded.value;
    if (entry.type === "session") {
      const declaredID = Option.fromUndefinedOr(entry.id);
      if (Option.isSome(declaredID)) sessionID = declaredID.value;
      const parent = Option.fromUndefinedOr(entry.parentSession);
      if (Option.isSome(parent)) parentSessionID = sessionIDFromFile(parent.value);
    }
    lines.push({ sessionID, parentSessionID, entry });
  }
  return lines;
};

/** An assistant message in the audit window, with its session identity. */
export interface PiOmpAssistantMessage {
  readonly sessionID: string;
  readonly parentSessionID: string | undefined;
  readonly timestamp: string;
  readonly message: NonNullable<PiOmpEntry["message"]>;
}

/** Assistant messages inside the window: the stream the extractor and the
 * attribution both walk, filtered once. */
export const assistantMessages = (
  lines: ReadonlyArray<PiOmpLine>,
  sinceIso: string,
): ReadonlyArray<PiOmpAssistantMessage> => {
  const messages: Array<PiOmpAssistantMessage> = [];
  for (const line of lines) {
    if (line.entry.type !== "message") continue;
    const message = Option.fromUndefinedOr(line.entry.message);
    if (Option.isNone(message) || message.value.role !== "assistant") continue;
    const timestamp = Option.fromUndefinedOr(line.entry.timestamp);
    if (Option.isNone(timestamp) || timestamp.value < sinceIso) continue;
    messages.push({
      sessionID: line.sessionID,
      parentSessionID: line.parentSessionID,
      timestamp: timestamp.value,
      message: message.value,
    });
  }
  return messages;
};

/** JSONL files under a session root, recursive: subagents live in subfolders. */
export const listJsonlFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(root, { recursive: true });
  return entries.filter((entry) => entry.endsWith(".jsonl")).map((entry) => join(root, entry));
};

/** One session file with its text, ready to parse. */
export interface SessionFile {
  readonly file: string;
  readonly raw: string;
}

/**
 * Read every session file under one root. A harness that was never used has no
 * sessions directory and contributes nothing; a file that vanishes mid-scan
 * contributes nothing; any other failure becomes the caller's own error, so
 * each surface keeps its error taxonomy.
 */
export const readSessionRoot = <E>(
  root: string,
  onError: (source: string) => E,
): Effect.Effect<ReadonlyArray<SessionFile>, E> =>
  Effect.gen(function* () {
    const files = yield* Effect.tryPromise({
      try: () => listJsonlFiles(root),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchIf(isNotFoundError, () => Effect.succeed([])),
      Effect.mapError(() => onError(root)),
    );
    const sessions: Array<SessionFile> = [];
    for (const file of files) {
      const raw = yield* Effect.tryPromise({
        try: () => readFile(file, "utf8"),
        catch: (cause) => cause,
      }).pipe(
        Effect.catchIf(isNotFoundError, () => Effect.succeed("")),
        Effect.mapError(() => onError(root)),
      );
      sessions.push({ file, raw });
    }
    return sessions;
  });
