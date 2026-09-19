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

/**
 * Harness tag as it appears in the log. `opencode2` is the tag written before
 * commit 8030103 renamed it to `opencode`; without the alias every pre-rename
 * event would fail to decode and be dropped as malformed.
 */
export const HarnessTag = Schema.Literals([...HARNESS_TAGS, "opencode2"]).pipe(
  Schema.decodeTo(Harness, {
    decode: SchemaGetter.transform((tag: Harness | "opencode2"): Harness =>
      tag === "opencode2" ? "opencode" : tag,
    ),
    encode: SchemaGetter.transform((tag: Harness): Harness | "opencode2" => tag),
  }),
);

/** Claim taxonomy shared by detection questions, opportunity events, and quoting. */
export const CLAIM_KINDS = ["percent", "probability", "ranking", "estimate", "choice"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

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

const BaseEvent = {
  ts: Schema.String,
  harness: HarnessTag,
  sessionID: Schema.optional(Schema.String),
} as const;

export const CallEvent = Schema.TaggedStruct("call", {
  ...BaseEvent,
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

export const OpportunityEvent = Schema.TaggedStruct("opportunity", {
  ...BaseEvent,
  source: Schema.Literals(["user_prompt", "assistant_message"]),
  pattern: Schema.String,
  matched: Schema.Boolean,
});
export type OpportunityEvent = Schema.Schema.Type<typeof OpportunityEvent>;

export const TriageEvent = Schema.TaggedStruct("triage", {
  ...BaseEvent,
  feature: Schema.Literals(["review", "failure", "commit", "verify"]),
  // Numeric counts/scores only; message text never belongs here.
  summary: Schema.Record(Schema.String, Schema.Number),
});
export type TriageEvent = Schema.Schema.Type<typeof TriageEvent>;

export const ReviewDirection = Schema.Literals([
  "improved",
  "unchanged",
  "regressed",
  "incomparable",
]);
export type ReviewDirection = Schema.Schema.Type<typeof ReviewDirection>;

export const ReviewDimensionResult = Schema.Struct({
  applicable: Schema.Boolean,
  score: Schema.optional(Schema.Number),
  confidence: Schema.optional(Schema.Number),
  direction: Schema.optional(ReviewDirection),
});
export type ReviewDimensionResult = Schema.Schema.Type<typeof ReviewDimensionResult>;

/** One quality review run: normalized dimension scores only, never code or diffs. */
export const ReviewEvent = Schema.TaggedStruct("review", {
  ...BaseEvent,
  model: Schema.String,
  dimensions: Schema.Record(Schema.String, ReviewDimensionResult),
  topWeakness: Schema.optional(Schema.String),
});
export type ReviewEvent = Schema.Schema.Type<typeof ReviewEvent>;

export const SessionLabelEvent = Schema.TaggedStruct("session_label", {
  ...BaseEvent,
  outcome: Schema.Literals(["shipped", "blocked", "abandoned", "ongoing"]),
  friction: Schema.Number,
  waste: Schema.Literals(["none", "loop", "truncation", "retries", "waiting_on_human"]),
  taskType: Schema.String,
});
export type SessionLabelEvent = Schema.Schema.Type<typeof SessionLabelEvent>;

export const JevEvent = Schema.Union([
  CallEvent,
  OpportunityEvent,
  TriageEvent,
  SessionLabelEvent,
  ReviewEvent,
]);
export type JevEvent = Schema.Schema.Type<typeof JevEvent>;
