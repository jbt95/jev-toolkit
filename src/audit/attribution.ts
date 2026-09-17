import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AuditError } from "./opportunities.ts";

/**
 * The MCP transport cannot carry a harness session id, so a `typesafe_ask` call
 * only records one when the model remembers to pass it. In practice almost none
 * do, which left every opportunity unmatched. This recovers the link offline by
 * matching a call's question ids against the assistant turn that actually issued
 * the ask — the tool part's code/first-class arguments, never the surrounding
 * prose. The toolkit's own triage calls are not tool parts, so they never match.
 */
export interface CallFingerprint {
  readonly questionIDs: ReadonlyArray<string>;
  readonly atMs: number;
}

/** One assistant turn that issued at least one `typesafe_ask`. */
export interface SessionTurn {
  readonly sessionID: string;
  readonly startMs: number;
  readonly endMs: number;
  /** Text from the ask invocations only: the call code and question keys. */
  readonly askText: string;
}

const ASK_TOOL = "typesafe_ask";

const ToolInput = Schema.Struct({
  code: Schema.optional(Schema.String),
  // Any JSON here: other tools may carry a `questions` field of another shape.
  questions: Schema.optional(Schema.Json),
});
const ToolPart = Schema.Struct({
  type: Schema.String,
  name: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Struct({ input: Schema.optional(ToolInput) })),
});
const AssistantData = Schema.Struct({ content: Schema.Array(ToolPart) });
const decodeAssistantData = Schema.decodeUnknownOption(Schema.fromJsonString(AssistantData));

const QuestionKeys = Schema.Record(Schema.String, Schema.Json);
const decodeQuestionKeys = Schema.decodeUnknownOption(QuestionKeys);

const TurnRow = Schema.Struct({
  session_id: Schema.String,
  time_created: Schema.Number,
  time_updated: Schema.Number,
  data: Schema.String,
});
const decodeTurnRow = Schema.decodeUnknownOption(TurnRow);

/** How far outside a turn a call may fall and still be attributed. */
export const ATTRIBUTION_WINDOW_MS = 30 * 60 * 1000;

const distanceToTurn = (turn: SessionTurn, atMs: number): number => {
  if (atMs < turn.startMs) return turn.startMs - atMs;
  if (atMs > turn.endMs) return atMs - turn.endMs;
  return 0;
};

/** The text of every `typesafe_ask` issued in one assistant message, or "". */
const askTextOf = (data: string): string => {
  const decoded = decodeAssistantData(data);
  if (Option.isNone(decoded)) return "";
  const fragments: Array<string> = [];
  for (const part of decoded.value.content) {
    if (part.type !== "tool") continue;
    const input = part.state?.input;
    const code = input?.code ?? "";
    const isAsk = (part.name ?? "").includes(ASK_TOOL) || code.includes(ASK_TOOL);
    if (!isAsk) continue;
    const questionKeys = Option.fromUndefinedOr(input?.questions).pipe(
      Option.flatMap((questions) => decodeQuestionKeys(questions)),
      Option.map((record) => Object.keys(record)),
      Option.getOrElse((): ReadonlyArray<string> => []),
    );
    fragments.push(code, ...questionKeys);
  }
  return fragments.join("\n");
};

/**
 * Resolve one call to the session whose turn issued its question ids. Calls with
 * no question ids are un-attributable; ties resolve to the nearest turn, then
 * the tightest one.
 */
export function attributeCalls(
  turns: ReadonlyArray<SessionTurn>,
  calls: ReadonlyArray<CallFingerprint>,
): ReadonlyArray<Option.Option<string>> {
  return calls.map((call) => {
    if (call.questionIDs.length === 0) return Option.none<string>();
    let best: SessionTurn | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const turn of turns) {
      if (!call.questionIDs.every((id) => turn.askText.includes(id))) continue;
      const distance = distanceToTurn(turn, call.atMs);
      if (distance > ATTRIBUTION_WINDOW_MS) continue;
      const bestSpan = best === undefined ? Number.POSITIVE_INFINITY : best.endMs - best.startMs;
      if (
        best === undefined ||
        distance < bestDistance ||
        (distance === bestDistance && turn.endMs - turn.startMs < bestSpan)
      ) {
        best = turn;
        bestDistance = distance;
      }
    }
    return best === undefined ? Option.none<string>() : Option.some(best.sessionID);
  });
}

/** Read assistant turns that issued a `typesafe_ask` from the transcript. */
export function loadOpencodeTurns(
  dbPath: string,
  sinceIso: string,
): Effect.Effect<ReadonlyArray<SessionTurn>, AuditError> {
  return Effect.try({
    try: () => {
      if (!existsSync(dbPath)) return [];
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const sinceMs = Date.parse(sinceIso);
        const rows = db
          .prepare(
            "SELECT session_id, time_created, time_updated, data FROM session_message " +
              "WHERE type = 'assistant' AND time_updated >= ?",
          )
          .all(sinceMs);
        const turns: Array<SessionTurn> = [];
        for (const row of rows) {
          const decoded = decodeTurnRow(row);
          if (Option.isNone(decoded)) continue;
          const askText = askTextOf(decoded.value.data);
          if (askText.length === 0) continue;
          turns.push({
            sessionID: decoded.value.session_id,
            startMs: decoded.value.time_created,
            endMs: decoded.value.time_updated,
            askText,
          });
        }
        return turns;
      } finally {
        db.close();
      }
    },
    catch: () => new AuditError({ source: "opencode2" }),
  });
}
