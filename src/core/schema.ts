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

/** Closed semantic purpose for a Jev judgment; raw task text never belongs here. */
export const CallPurpose = Schema.Literals([
  "ask",
  "claim_detection",
  "claim_alignment",
  "session_label",
  "commit_check",
  "review",
  "verify",
  "route",
  "triage",
  "eval",
]);
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
  /** Optional for backwards-compatible decoding of pre-identity events. */
  callID: Schema.optional(Schema.String),
  /** Optional for backwards-compatible decoding of pre-purpose events. */
  purpose: Schema.optional(CallPurpose),
  /** Serialized state size bucket; raw state never enters the event. */
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

export const OpportunityEvent = Schema.TaggedStruct("opportunity", {
  ...BaseEvent,
  source: Schema.Literals(["user_prompt", "assistant_message"]),
  pattern: Schema.String,
  matched: Schema.Boolean,
  /** Timestamp of the detected message; identifies one detection so repeated
   * audit windows cannot double-count the same claim. */
  messageTs: Schema.optional(Schema.String),
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

/** Model token usage summed over one session. */
export const SessionTokens = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
});
export type SessionTokens = Schema.Schema.Type<typeof SessionTokens>;

export const SessionLabelEvent = Schema.TaggedStruct("session_label", {
  ...BaseEvent,
  outcome: Schema.Literals(["shipped", "blocked", "abandoned", "ongoing"]),
  friction: Schema.Number,
  waste: Schema.Literals(["none", "loop", "truncation", "retries", "waiting_on_human"]),
  taskType: Schema.String,
  // Digest facts travel with the label so the meter can total them per session.
  costUsd: Schema.optional(Schema.Number),
  tokens: Schema.optional(SessionTokens),
  toolErrors: Schema.optional(Schema.Number),
  stopReasons: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  parentSessionID: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  firstToolAt: Schema.optional(Schema.String),
});
export type SessionLabelEvent = Schema.Schema.Type<typeof SessionLabelEvent>;

export const CheckpointKind = Schema.Literals([
  "test",
  "lint",
  "build",
  "review",
  "commit",
  "rework",
]);
export type CheckpointKind = Schema.Schema.Type<typeof CheckpointKind>;

export const CheckpointResult = Schema.Literals(["pass", "fail", "resolved", "reverted"]);
export type CheckpointResult = Schema.Schema.Type<typeof CheckpointResult>;

export const CheckpointSource = Schema.Literals(["harness", "ci", "git", "operator"]);
export type CheckpointSource = Schema.Schema.Type<typeof CheckpointSource>;

/** One privacy-safe downstream outcome observation; raw evidence stays local. */
export const CheckpointEvent = Schema.TaggedStruct("checkpoint", {
  ...BaseEvent,
  callID: Schema.optional(Schema.String),
  kind: CheckpointKind,
  result: CheckpointResult,
  source: CheckpointSource,
});
export type CheckpointEvent = Schema.Schema.Type<typeof CheckpointEvent>;

export const CorrectionKind = Schema.Literals([
  "correction",
  "override",
  "clarification",
  "handoff",
  "accepted",
  "rejected",
  "escalation",
]);
export type CorrectionKind = Schema.Schema.Type<typeof CorrectionKind>;

export const CorrectionSource = Schema.Literals(["harness", "transcript", "operator"]);
export type CorrectionSource = Schema.Schema.Type<typeof CorrectionSource>;

/** Privacy-safe record of an observable intervention response. */
export const CorrectionEvent = Schema.TaggedStruct("correction", {
  ...BaseEvent,
  callID: Schema.optional(Schema.String),
  kind: CorrectionKind,
  source: CorrectionSource,
});
export type CorrectionEvent = Schema.Schema.Type<typeof CorrectionEvent>;

export const CohortName = Schema.Literals(["assisted", "holdout"]);
export type CohortName = Schema.Schema.Type<typeof CohortName>;

export const CohortSource = Schema.Literals(["operator", "experiment"]);
export type CohortSource = Schema.Schema.Type<typeof CohortSource>;

/** Explicit assignment for an opt-in observational or controlled comparison. */
export const CohortEvent = Schema.TaggedStruct("cohort", {
  ...BaseEvent,
  sessionID: Schema.String,
  cohort: CohortName,
  source: CohortSource,
});
export type CohortEvent = Schema.Schema.Type<typeof CohortEvent>;

/**
 * A call recovered to a session offline by `audit run`. No harness forwards a
 * session id over MCP, so without this record the meter cannot see which
 * sessions used Jev at all.
 */
export const AttributionEvent = Schema.TaggedStruct("attribution", {
  ...BaseEvent,
  sessionID: Schema.String,
});
export type AttributionEvent = Schema.Schema.Type<typeof AttributionEvent>;

/**
 * One skill-routing decision: which skill the caller should load for a task, or
 * why none routed. The task text never enters the log, only the outcome.
 */
export const RouteEvent = Schema.TaggedStruct("route", {
  ...BaseEvent,
  outcome: Schema.Literals(["routed", "none"]),
  reason: Schema.optional(
    Schema.Literals(["no-match", "low-confidence", "low-dependence", "unknown-skill"]),
  ),
  /** Chosen skill name when routed; a taxonomy label, never user text. */
  skill: Schema.optional(Schema.String),
  /**
   * The ordered chain when a follow-up selection routed; `skill` stays the
   * first pick for consumers written before chains existed.
   */
  skills: Schema.optional(Schema.Array(Schema.String)),
  candidates: Schema.Number,
  confidence: Schema.Number,
  dependence: Schema.Number,
});
export type RouteEvent = Schema.Schema.Type<typeof RouteEvent>;

/** Discriminator tags of every persisted event kind, for filters and tooling. */
export const EventTag = Schema.Literals([
  "call",
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
export type EventTag = Schema.Schema.Type<typeof EventTag>;

export const JevEvent = Schema.Union([
  CallEvent,
  OpportunityEvent,
  TriageEvent,
  SessionLabelEvent,
  CheckpointEvent,
  CorrectionEvent,
  CohortEvent,
  ReviewEvent,
  AttributionEvent,
  RouteEvent,
]);
export type JevEvent = Schema.Schema.Type<typeof JevEvent>;
