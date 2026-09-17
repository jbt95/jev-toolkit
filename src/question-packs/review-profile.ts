import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { noulValue } from "../core/answers.ts";
import type { Answer, AnswerMap, Question, QuestionMap } from "../core/schema.ts";
import { clip, redact } from "../core/text.ts";

/**
 * Core quality dimensions for one review. Every dimension is independent:
 * applicability decides whether the state supports it, the score places it on
 * dimension-specific levels, and comparison is a direct judgment rather than a
 * subtraction of two separately produced numbers.
 */
export const REVIEW_DIMENSIONS = [
  "correctness",
  "cognitive_complexity",
  "readability",
  "modularity",
  "coupling",
  "changeability",
  "test_quality",
  "security",
] as const;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

export const DIMENSION_LABELS: Readonly<Record<ReviewDimension, string>> = {
  correctness: "correctness and requirement fit",
  cognitive_complexity: "cognitive complexity",
  readability: "readability and intent",
  modularity: "modularity and cohesion",
  coupling: "coupling and dependency quality",
  changeability: "changeability and change amplification",
  test_quality: "testability and test evidence",
  security: "security",
};

const DIMENSION_GUIDANCE: Readonly<Record<ReviewDimension, string>> = {
  correctness:
    "Judge requested behavior, missing behavior, edge cases, invariants, assumptions, and regressions. Correctness outweighs style.",
  cognitive_complexity:
    "Judge nesting, branching, hidden control flow, indirection, side effects, and special cases. Do not use length alone.",
  readability:
    "Judge naming, control and data flow clarity, responsibilities, transformations, and whether comments add or remove noise.",
  modularity:
    "Judge coherent grouping, separated responsibilities, and boundaries. Do not reward small files by default.",
  coupling:
    "Judge unnecessary dependencies, dependency direction, leaked implementation details, circularity, and hidden dependencies.",
  changeability:
    "Judge whether a conceptual change has a small, predictable edit surface or is scattered and brittle.",
  test_quality:
    "Judge whether important behavior and edge cases are verified, and whether the tests would catch a regression.",
  security:
    "Judge input handling, trust boundaries, credential handling, and whether the change introduces or removes a protection.",
};

/** Five concrete levels per dimension; levels describe situations, not degrees. */
export const DIMENSION_LEVELS: Readonly<Record<ReviewDimension, ReadonlyArray<string>>> = {
  correctness: [
    "Requested behavior is missing or wrong in ways this change does not address.",
    "Part of the requested behavior is present, but important cases are wrong, absent, or unhandled.",
    "The requested behavior is mostly present, with notable gaps, edge cases, or regressions remaining.",
    "The requested behavior is present and edge cases and invariants are handled, with only minor gaps.",
    "The requested behavior is complete, and edge cases, invariants, and failure modes are handled deliberately.",
  ],
  cognitive_complexity: [
    "Control flow is very hard to follow: deep nesting, hidden state, or special cases dominate.",
    "Several parts require careful tracing because of nesting, indirection, or special cases.",
    "Mostly followable, but some flow or state handling demands more attention than the problem requires.",
    "Control flow and state are easy to follow; complexity is close to what the problem requires.",
    "The simplest reasonable control and data flow for the problem; complexity stays contained and explicit.",
  ],
  readability: [
    "Names and flow obscure intent; a reader cannot tell what the code does without heavy inference.",
    "Intent is often unclear from names, flow, or structure, and comments do not compensate.",
    "Mostly readable, but some names, flows, or comments leave intent ambiguous.",
    "Intent is clear from names and flow, and comments explain only what code cannot.",
    "Intent is immediately clear and navigation is easy; naming and structure carry the meaning.",
  ],
  modularity: [
    "Responsibilities are mixed or boundaries are absent; the change cannot be understood in parts.",
    "Several unrelated responsibilities share a module, or a cohesive concept is scattered.",
    "Boundaries mostly make sense, but some responsibilities sit in the wrong place.",
    "Responsibilities are grouped coherently with clear boundaries and little duplicated knowledge.",
    "Cohesive modules with explicit boundaries; each part can be understood and changed on its own.",
  ],
  coupling: [
    "Dependencies are tangled or circular; a change here forces changes in unrelated code.",
    "Tight or hidden dependencies make the change risky to extend or reuse.",
    "Some dependencies leak details or point the wrong way, but they stay contained.",
    "Dependencies point in sensible directions with little leakage of implementation detail.",
    "Dependencies are explicit, minimal, and directed so this code can change or be reused safely.",
  ],
  changeability: [
    "A small conceptual change would require edits scattered across many unrelated places.",
    "Related rules or knowledge are scattered, so changes are error-prone.",
    "Some knowledge is duplicated or hidden, but a typical change has a findable edit surface.",
    "A conceptual change touches a small, predictable set of places.",
    "Each rule has one clear home; the next related change is local and predictable.",
  ],
  test_quality: [
    "No meaningful verification; behavior that matters is untested or contradicted by tests.",
    "Tests exist but miss important behavior, edge cases, or failure modes.",
    "Core behavior is covered, but notable gaps or brittle assertions remain.",
    "Important behavior and edge cases are covered by tests that would fail on a regression.",
    "Tests make the important behavior and its edge cases verifiable and give confidence to refactor.",
  ],
  security: [
    "The change introduces a concrete security flaw or removes an existing protection.",
    "A plausible security weakness is introduced or left unhandled in the touched surfaces.",
    "No obvious flaw, but inputs, credentials, or trust boundaries are handled loosely.",
    "Inputs and trust boundaries are handled carefully with no evident weakness.",
    "Security-relevant boundaries, inputs, and failure modes are explicitly and defensibly handled.",
  ],
};

/** Highest score index; scores are 0..REVIEW_SCORE_MAX over the level array. */
export const REVIEW_SCORE_MAX = DIMENSION_LEVELS.correctness.length - 1;

export const DIRECTION_VALUES = ["improved", "unchanged", "regressed", "incomparable"] as const;
export type ReviewDirection = (typeof DIRECTION_VALUES)[number];

/** Policy: an applicability noul below this means the dimension is not judged. */
export const APPLICABILITY_THRESHOLD = 0.5;

export const ReviewFile = Schema.Struct({
  path: Schema.NonEmptyString,
  content: Schema.String,
});

export const PreviousDimension = Schema.Struct({
  dimension: Schema.String,
  applicable: Schema.Boolean,
  score: Schema.Number,
  confidence: Schema.Number,
});

export const PreviousEvaluation = Schema.Struct({
  dimensions: Schema.Array(PreviousDimension),
});
export type PreviousEvaluation = Schema.Schema.Type<typeof PreviousEvaluation>;

/**
 * The review state is caller-supplied code: an explicit opt-in boundary that
 * redacts credentials and clips before anything leaves the machine. Raw code
 * never enters the event log.
 */
export const ReviewInput = Schema.Struct({
  task: Schema.optional(Schema.String),
  diff: Schema.optional(Schema.String),
  files: Schema.optional(Schema.Array(ReviewFile)),
  repositoryContext: Schema.optional(Schema.String),
  previousEvaluation: Schema.optional(PreviousEvaluation),
});
export type ReviewInput = Schema.Schema.Type<typeof ReviewInput>;

const TASK_LIMIT = 1500;
const CONTEXT_LIMIT = 6000;
const DIFF_LIMIT = 30000;
const FILE_LIMIT = 12000;
const MAX_FILES = 8;

const sanitized = (value: string | undefined, limit: number): string | undefined =>
  Option.fromUndefinedOr(value).pipe(
    Option.map((text) => clip(redact(text), limit)),
    Option.getOrUndefined,
  );

/** Redact credentials and clip every field before the review leaves the machine. */
export const sanitizeReviewInput = (input: ReviewInput): ReviewInput => {
  const files = (input.files ?? []).slice(0, MAX_FILES).map((file) => ({
    path: file.path,
    content: clip(redact(file.content), FILE_LIMIT),
  }));
  return {
    task: sanitized(input.task, TASK_LIMIT),
    diff: sanitized(input.diff, DIFF_LIMIT),
    files: files.length > 0 ? files : undefined,
    repositoryContext: sanitized(input.repositoryContext, CONTEXT_LIMIT),
    previousEvaluation: input.previousEvaluation,
  };
};

export const hasReviewContext = (input: ReviewInput): boolean =>
  (input.task?.trim().length ?? 0) > 0 ||
  (input.diff?.trim().length ?? 0) > 0 ||
  (input.repositoryContext?.trim().length ?? 0) > 0 ||
  (input.files ?? []).some((file) => file.content.trim().length > 0);

const previousByDimension = (
  input: ReviewInput,
): ReadonlyMap<ReviewDimension, { score: number; confidence: number }> => {
  const previous = new Map<ReviewDimension, { score: number; confidence: number }>();
  for (const entry of input.previousEvaluation?.dimensions ?? []) {
    const dimension = REVIEW_DIMENSIONS.find((candidate) => candidate === entry.dimension);
    if (dimension === undefined || !entry.applicable) continue;
    previous.set(dimension, { score: entry.score, confidence: entry.confidence });
  }
  return previous;
};

/**
 * Per dimension: an applicability gate, a score over dimension-specific levels,
 * and — when a previous evaluation is supplied — a direct comparison judgment.
 * One review-level question names the most consequential weakness.
 */
export const reviewQuestions = (input: ReviewInput): QuestionMap => {
  const questions: Record<string, Question> = {};
  for (const dimension of REVIEW_DIMENSIONS) {
    questions[`${dimension}_applicable`] = {
      _tag: "noul",
      instructions:
        `Does the review state contain enough evidence to assess ${DIMENSION_LABELS[dimension]} ` +
        `for this change? Answer no when the context is too thin for a defensible judgment; do not invent concerns.`,
    };
    questions[`${dimension}_score`] = {
      _tag: "score",
      instructions: `Rate ${DIMENSION_LABELS[dimension]} for the change in the review state. ${DIMENSION_GUIDANCE[dimension]}`,
      criteria: DIMENSION_LEVELS[dimension],
    };
  }

  const weakCriteria: Record<string, string> = {};
  for (const dimension of REVIEW_DIMENSIONS) {
    weakCriteria[dimension] = DIMENSION_LABELS[dimension];
  }
  weakCriteria["none_material"] = "no material weakness in the reviewed change";
  questions["top_weakness"] = {
    _tag: "choice",
    instructions:
      "Which single dimension has the most consequential weakness in this change? " +
      "Choose none_material only when no dimension shows a material weakness.",
    criteria: weakCriteria,
  };

  for (const [dimension, previous] of previousByDimension(input)) {
    questions[`${dimension}_direction`] = {
      _tag: "choice",
      instructions:
        `A previous evaluation scored ${DIMENSION_LABELS[dimension]} at ${previous.score} of ` +
        `${REVIEW_SCORE_MAX} with confidence ${previous.confidence}, based on an earlier version. ` +
        `Compared with that earlier version, has ${DIMENSION_LABELS[dimension]} improved, regressed, ` +
        `stayed effectively unchanged, or cannot be compared from the supplied state?`,
      criteria: {
        improved: "the current state is meaningfully better on this dimension",
        unchanged: "the current state is effectively equivalent on this dimension",
        regressed: "the current state is meaningfully worse on this dimension",
        incomparable: "the change is too different or the evidence too thin to compare",
      },
    };
  }
  return questions;
};

export interface ReviewedDimension {
  readonly dimension: ReviewDimension;
  readonly label: string;
  readonly applicable: boolean;
  readonly score?: number;
  readonly confidence?: number;
  readonly direction?: ReviewDirection;
}

export interface ReviewOutcome {
  readonly dimensions: ReadonlyArray<ReviewedDimension>;
  readonly topWeakness: string;
}

/** Code composes the answers: gates, scores, directions, and the top weakness. */
export const evaluateReview = (input: ReviewInput, answers: AnswerMap): ReviewOutcome => {
  const previous = previousByDimension(input);
  const dimensions = REVIEW_DIMENSIONS.map((dimension): ReviewedDimension => {
    const applicable = noulValue(answers, `${dimension}_applicable`) >= APPLICABILITY_THRESHOLD;
    if (!applicable) {
      return { dimension, label: DIMENSION_LABELS[dimension], applicable: false };
    }
    const scoreAnswer = Option.fromUndefinedOr(answers[`${dimension}_score`]).pipe(
      Option.filter(
        (answer): answer is Extract<Answer, { readonly _tag: "score" }> => answer._tag === "score",
      ),
    );
    const direction = Option.fromUndefinedOr(answers[`${dimension}_direction`]).pipe(
      Option.filter(
        (answer): answer is Extract<Answer, { readonly _tag: "choice" }> =>
          answer._tag === "choice",
      ),
      Option.filter(() => previous.has(dimension)),
      Option.flatMap((answer) =>
        Option.fromUndefinedOr(DIRECTION_VALUES.find((candidate) => candidate === answer.choice)),
      ),
    );
    return {
      dimension,
      label: DIMENSION_LABELS[dimension],
      applicable: true,
      score: Option.map(scoreAnswer, (answer) => answer.score).pipe(Option.getOrUndefined),
      confidence: Option.map(scoreAnswer, (answer) => answer.confidence).pipe(
        Option.getOrUndefined,
      ),
      direction: Option.getOrUndefined(direction),
    };
  });
  const topWeakness = Option.fromUndefinedOr(answers["top_weakness"]).pipe(
    Option.filter(
      (answer): answer is Extract<Answer, { readonly _tag: "choice" }> => answer._tag === "choice",
    ),
    Option.map((answer) => answer.choice),
    Option.getOrElse(() => "none_material"),
  );
  return { dimensions, topWeakness };
};

/** Raw scores are 0..REVIEW_SCORE_MAX; events store the normalized 0..1 value. */
export const normalizeReviewScore = (score: number): number =>
  Math.round((score / REVIEW_SCORE_MAX) * 1000) / 1000;
