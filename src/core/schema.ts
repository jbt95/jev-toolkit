import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

const HARNESS_TAGS = ["opencode", "claude-code", "pi", "omp", "cli", "script"] as const;

/** Closed set of client failures that can appear on an error `call` event. */
export const JevErrorTag = Schema.Literals([
  "JevConfigError",
  "JevTransportError",
  "JevTimeoutError",
  "JevApiError",
  "JevDecodeError",
]);
export type JevErrorTag = Schema.Schema.Type<typeof JevErrorTag>;

export const Harness = Schema.Literals(HARNESS_TAGS);
export type Harness = Schema.Schema.Type<typeof Harness>;

/** Accept the pre-rename harness tag when reading an existing event log. */
export const HarnessTag = Schema.Literals([...HARNESS_TAGS, "opencode2"]).pipe(
  Schema.decodeTo(Harness, {
    decode: SchemaGetter.transform((tag: Harness | "opencode2"): Harness =>
      tag === "opencode2" ? "opencode" : tag,
    ),
    encode: SchemaGetter.transform((tag: Harness): Harness | "opencode2" => tag),
  }),
);

export const QuestionType = Schema.Literals(["choice", "noul", "score"]);
export type QuestionType = Schema.Schema.Type<typeof QuestionType>;

const Criteria = Schema.Record(Schema.String, Schema.NonEmptyString);

export const ChoiceQuestion = Schema.TaggedStruct("choice", {
  instructions: Schema.NonEmptyString,
  criteria: Criteria,
});
export const NoulQuestion = Schema.TaggedStruct("noul", {
  instructions: Schema.NonEmptyString,
  criteria: Schema.optional(Schema.NullOr(Criteria)),
});
export const ScoreQuestion = Schema.TaggedStruct("score", {
  instructions: Schema.NonEmptyString,
  criteria: Schema.Array(Schema.NonEmptyString),
});
export const Question = Schema.Union([ChoiceQuestion, NoulQuestion, ScoreQuestion]);
export type Question = Schema.Schema.Type<typeof Question>;
export const QuestionMap = Schema.Record(Schema.String, Question);
export type QuestionMap = Schema.Schema.Type<typeof QuestionMap>;

export const NoulAnswer = Schema.TaggedStruct("noul", { noul: Schema.Number });
export const ChoiceAnswer = Schema.TaggedStruct("choice", {
  choice: Schema.String,
  confidence: Schema.Number,
  probabilities: Schema.Record(Schema.String, Schema.Number),
});
export const ScoreAnswer = Schema.TaggedStruct("score", {
  score: Schema.Number,
  confidence: Schema.Number,
  probabilities: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
});
export const Answer = Schema.Union([NoulAnswer, ChoiceAnswer, ScoreAnswer]);
export type Answer = Schema.Schema.Type<typeof Answer>;
export const AnswerMap = Schema.Record(Schema.String, Answer);
export type AnswerMap = Schema.Schema.Type<typeof AnswerMap>;

export const CallPurpose = Schema.Literals(["ask", "rank", "verify"]);
export type CallPurpose = Schema.Schema.Type<typeof CallPurpose>;

export const StateSizeBucket = Schema.Literals(["0_1k", "1k_10k", "10k_50k", "50k_plus"]);
export type StateSizeBucket = Schema.Schema.Type<typeof StateSizeBucket>;

const BaseEvent = {
  ts: Schema.String,
  harness: HarnessTag,
  sessionID: Schema.optional(Schema.String),
} as const;

export const CallEvent = Schema.TaggedStruct("call", {
  ...BaseEvent,
  callID: Schema.optional(Schema.String),
  purpose: Schema.optional(CallPurpose),
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
export type CallEvent = Schema.Schema.Type<typeof CallEvent>;

export const VerifyEvent = Schema.TaggedStruct("verify", {
  ...BaseEvent,
  summary: Schema.Record(Schema.String, Schema.Number),
});
export type VerifyEvent = Schema.Schema.Type<typeof VerifyEvent>;

export const JevEvent = Schema.Union([CallEvent, VerifyEvent]);
export type JevEvent = Schema.Schema.Type<typeof JevEvent>;
