import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AuditError } from "./opportunities.ts";

/**
 * The MCP transport cannot carry a harness session id, so a Jev call only
 * records one when the model remembers to pass it. In Code Mode the model
 * calls Jev through the `execute` wrapper (`tools.jev.typesafe_*` in code),
 * which never passes one either — in practice almost no opencode call carries
 * a session id, which left every opportunity unmatched. This recovers the link
 * offline by matching a call's question ids against the assistant turn that
 * actually issued the ask — the tool part's code/first-class arguments, never
 * the surrounding prose. `typesafe_verify` and `typesafe_review` generate
 * their question ids server-side, so their ids never appear at the call site;
 * those fall back to the nearest turn that invoked the same tool.
 */
export interface CallFingerprint {
  readonly questionIDs: ReadonlyArray<string>;
  readonly atMs: number;
}

/** One assistant turn that issued at least one Jev call. */
export interface SessionTurn {
  readonly sessionID: string;
  readonly startMs: number;
  readonly endMs: number;
  /** Text from the Jev invocations only: the call code and question keys. */
  readonly askText: string;
  /** Which Jev tools the turn invoked. */
  readonly markers: ReadonlyArray<string>;
}

const JEV_TOOL_MARKERS: ReadonlyArray<string> = [
  "typesafe_ask",
  "typesafe_verify",
  "typesafe_review",
];

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

interface JevInvocation {
  readonly text: string;
  readonly markers: ReadonlyArray<string>;
}

/** The text of every Jev call issued in one assistant message, or "". */
const jevInvocationOf = (data: string): JevInvocation => {
  const decoded = decodeAssistantData(data);
  if (Option.isNone(decoded)) return { text: "", markers: [] };
  const fragments: Array<string> = [];
  const markers: Array<string> = [];
  for (const part of decoded.value.content) {
    if (part.type !== "tool") continue;
    const input = part.state?.input;
    const code = input?.code ?? "";
    const found = JEV_TOOL_MARKERS.filter(
      (marker) => (part.name ?? "").includes(marker) || code.includes(marker),
    );
    if (found.length === 0) continue;
    for (const marker of found) {
      if (!markers.includes(marker)) markers.push(marker);
    }
    const questionKeys = Option.fromUndefinedOr(input?.questions).pipe(
      Option.flatMap((questions) => decodeQuestionKeys(questions)),
      Option.map((record) => Object.keys(record)),
      Option.getOrElse((): ReadonlyArray<string> => []),
    );
    fragments.push(code, ...questionKeys);
  }
  return { text: fragments.join("\n"), markers };
};

const turnMatches = (turn: SessionTurn, call: CallFingerprint): boolean =>
  call.questionIDs.every((id) => turn.askText.includes(id)) &&
  distanceToTurn(turn, call.atMs) <= ATTRIBUTION_WINDOW_MS;

const VERIFY_QUESTION = /^c\d+_verdict$/;

/**
 * Server-generated question ids never appear at the call site, so they can
 * only be linked by tool. Verify calls carry `cN_verdict` ids, review calls
 * carry `*_applicable` / `*_score` ids; anything else is ask-shaped and keeps
 * the id-matching path above.
 */
const fallbackMarker = (call: CallFingerprint): string | undefined => {
  if (call.questionIDs.length === 0) return undefined;
  if (call.questionIDs.every((id) => VERIFY_QUESTION.test(id))) return "typesafe_verify";
  const isReview = call.questionIDs.some(
    (id) => id.endsWith("_applicable") || id.endsWith("_score"),
  );
  return isReview ? "typesafe_review" : undefined;
};

const nearestTurnWith = (
  turns: ReadonlyArray<SessionTurn>,
  call: CallFingerprint,
  marker: string,
): SessionTurn | undefined => {
  let best: SessionTurn | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const turn of turns) {
    if (!turn.markers.includes(marker)) continue;
    const distance = distanceToTurn(turn, call.atMs);
    if (distance > ATTRIBUTION_WINDOW_MS) continue;
    if (isBetterTurn(turn, distance, best, bestDistance)) {
      best = turn;
      bestDistance = distance;
    }
  }
  return best;
};

/** Closer wins; an equal distance prefers the tighter turn span. */
const isBetterTurn = (
  candidate: SessionTurn,
  candidateDistance: number,
  best: SessionTurn | undefined,
  bestDistance: number,
): boolean => {
  if (best === undefined) return true;
  if (candidateDistance !== bestDistance) return candidateDistance < bestDistance;
  return candidate.endMs - candidate.startMs < best.endMs - best.startMs;
};

/**
 * Resolve one call to the session whose turn issued its question ids, falling
 * back to the nearest turn that invoked the same Jev tool when the ids are
 * server-generated (verify/review). Calls with no question ids are
 * un-attributable; ties resolve to the nearest turn, then the tightest one.
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
      if (!turnMatches(turn, call)) continue;
      const distance = distanceToTurn(turn, call.atMs);
      if (isBetterTurn(turn, distance, best, bestDistance)) {
        best = turn;
        bestDistance = distance;
      }
    }
    if (best !== undefined) return Option.some(best.sessionID);
    const marker = fallbackMarker(call);
    if (marker === undefined) return Option.none<string>();
    return Option.fromUndefinedOr(nearestTurnWith(turns, call, marker)).pipe(
      Option.map((turn) => turn.sessionID),
    );
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
          const invocation = jevInvocationOf(decoded.value.data);
          if (invocation.text.length === 0) continue;
          turns.push({
            sessionID: decoded.value.session_id,
            startMs: decoded.value.time_created,
            endMs: decoded.value.time_updated,
            askText: invocation.text,
            markers: invocation.markers,
          });
        }
        return turns;
      } finally {
        db.close();
      }
    },
    catch: () => new AuditError({ source: "opencode" }),
  });
}
