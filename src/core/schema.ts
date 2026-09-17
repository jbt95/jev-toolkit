import * as Schema from "effect/Schema";

export const Harness = Schema.Literals(["opencode2", "claude-code", "pi", "omp", "cli", "script"]);
export type Harness = Schema.Schema.Type<typeof Harness>;

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
  harness: Harness,
  sessionID: Schema.optional(Schema.String),
} as const;

export const CallEvent = Schema.TaggedStruct("call", {
  ...BaseEvent,
  model: Schema.String,
  latencyMs: Schema.Number,
  status: Schema.Literals(["ok", "error"]),
  error: Schema.optional(Schema.String),
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
  feature: Schema.Literals(["review", "failure", "commit"]),
  // Numeric counts/scores only; message text never belongs here.
  summary: Schema.Record(Schema.String, Schema.Number),
});
export type TriageEvent = Schema.Schema.Type<typeof TriageEvent>;

export const SessionLabelEvent = Schema.TaggedStruct("session_label", {
  ...BaseEvent,
  outcome: Schema.Literals(["shipped", "blocked", "abandoned", "ongoing"]),
  friction: Schema.Number,
  waste: Schema.Literals(["none", "loop", "truncation", "retries", "waiting_on_human"]),
  taskType: Schema.String,
});
export type SessionLabelEvent = Schema.Schema.Type<typeof SessionLabelEvent>;

export const JevEvent = Schema.Union([CallEvent, OpportunityEvent, TriageEvent, SessionLabelEvent]);
export type JevEvent = Schema.Schema.Type<typeof JevEvent>;
