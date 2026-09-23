import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isNotFoundError } from "./fs-errors.ts";
import {
  AnswerMap,
  HarnessTag,
  JevErrorTag,
  JevEvent,
  QuestionType,
  StateSizeBucket,
} from "./schema.ts";

export class EventLogError extends Data.TaggedError("EventLogError")<{
  readonly operation: "encode" | "append" | "read";
}> {}

export interface EventLogService {
  readonly append: (event: JevEvent) => Effect.Effect<void, EventLogError>;
  readonly read: () => Effect.Effect<ReadonlyArray<StoredEvent>, EventLogError>;
}

export class EventLog extends Context.Service<EventLog, EventLogService>()("jev/EventLog") {}

const JevEventLine = Schema.fromJsonString(JevEvent);
const encodeLine = Schema.encodeEffect(JevEventLine);
const decodeLine = Schema.decodeUnknownOption(JevEventLine);

const LegacyEventKind = Schema.Literals([
  "opportunity",
  "triage",
  "session_label",
  "checkpoint",
  "correction",
  "cohort",
  "review",
  "attribution",
  "route",
]);
type LegacyEventKind = Schema.Schema.Type<typeof LegacyEventKind>;

const LegacyEventEnvelope = Schema.Struct({
  _tag: LegacyEventKind,
  ts: Schema.String,
  harness: HarnessTag,
  sessionID: Schema.optional(Schema.String),
});

const LegacyCallEvent = Schema.Struct({
  _tag: Schema.Literal("call"),
  ts: Schema.String,
  harness: HarnessTag,
  sessionID: Schema.optional(Schema.String),
  callID: Schema.optional(Schema.String),
  purpose: Schema.optional(
    Schema.Literals([
      "claim_detection",
      "claim_alignment",
      "session_label",
      "commit_check",
      "review",
      "route",
      "triage",
      "eval",
    ]),
  ),
  stateSizeBucket: Schema.optional(StateSizeBucket),
  model: Schema.String,
  latencyMs: Schema.Number,
  status: Schema.Literals(["ok", "error"]),
  error: Schema.optional(Schema.String),
  errorTag: Schema.optional(JevErrorTag),
  questions: Schema.Array(Schema.Struct({ id: Schema.String, type: QuestionType })),
  answers: Schema.optional(AnswerMap),
  tokens: Schema.optional(Schema.Struct({ input: Schema.Number, output: Schema.Number })),
});

const decodeJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject));
const decodeLegacyEventEnvelope = Schema.decodeUnknownOption(LegacyEventEnvelope);
const decodeLegacyCallEvent = Schema.decodeUnknownOption(LegacyCallEvent);

/** Retains retired event records losslessly without accepting them for new writes. */
type LegacyEvent = {
  readonly _tag: "legacy";
  readonly kind: LegacyEventKind | "call";
  readonly ts: string;
  readonly harness: Schema.Schema.Type<typeof HarnessTag>;
  readonly record: Schema.Schema.Type<typeof Schema.JsonObject>;
};
export type StoredEvent = JevEvent | LegacyEvent;

const decodeLegacyEvent = (line: string): Option.Option<LegacyEvent> => {
  const json = decodeJsonObject(line);
  if (Option.isNone(json)) return Option.none();

  const legacyCall = decodeLegacyCallEvent(json.value);
  if (Option.isSome(legacyCall)) {
    return Option.some({
      _tag: "legacy",
      kind: "call",
      ts: legacyCall.value.ts,
      harness: legacyCall.value.harness,
      record: json.value,
    });
  }

  return Option.map(decodeLegacyEventEnvelope(json.value), (envelope) => ({
    _tag: "legacy",
    kind: envelope._tag,
    ts: envelope.ts,
    harness: envelope.harness,
    record: json.value,
  }));
};

const appendEventLine = async (path: string, line: string): Promise<void> => {
  const directory = path.slice(0, path.lastIndexOf("/")) || ".";
  await Bun.$`mkdir -p ${directory}`.quiet();
  await Bun.$`printf "%s\\n" ${line} >> ${path}`.quiet();
};

export function makeEventLog(path: string): EventLogService {
  const append = (event: JevEvent): Effect.Effect<void, EventLogError> =>
    Effect.gen(function* appendProgram() {
      const line = yield* encodeLine(event).pipe(
        Effect.mapError(() => new EventLogError({ operation: "encode" })),
      );
      yield* Effect.tryPromise({
        try: () => appendEventLine(path, line),
        catch: () => new EventLogError({ operation: "append" }),
      });
    });

  const read = () =>
    Effect.gen(function* readEventLogProgram() {
      const raw = yield* Effect.tryPromise({
        try: () => Bun.file(path).text(),
        catch: (cause) => cause,
      }).pipe(
        Effect.catchIf(isNotFoundError, () => Effect.succeed("")),
        Effect.mapError(() => new EventLogError({ operation: "read" })),
      );
      const events: Array<StoredEvent> = [];
      for (const line of raw.split("\n")) {
        const parsed = decodeLine(line);
        if (Option.isSome(parsed)) {
          events.push(parsed.value);
          continue;
        }
        const legacy = decodeLegacyEvent(line);
        if (Option.isSome(legacy)) events.push(legacy.value);
      }
      return events;
    });

  return { append, read };
}

export const EventLogLive = (path: string): Layer.Layer<EventLog> =>
  Layer.succeed(EventLog, makeEventLog(path));
