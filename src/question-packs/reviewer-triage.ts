import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Answer, AnswerMap, Question, QuestionMap } from "../core/schema.ts";

export const Finding = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  detail: Schema.String,
  file: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Number),
});
export type Finding = Schema.Schema.Type<typeof Finding>;

export const ReviewInput = Schema.Struct({
  meta: Schema.optional(Schema.Struct({ note: Schema.optional(Schema.String) })),
  findings: Schema.Array(Finding),
});
export type ReviewInput = Schema.Schema.Type<typeof ReviewInput>;

const CLASS_LEVELS = {
  blocking: "must be fixed before shipping",
  cosmetic: "nice-to-have, style, or polish",
  question: "needs clarification or more evidence",
} as const;

/** One batched question set: three per finding plus two review-level gates. */
export function reviewQuestions(findings: ReadonlyArray<Finding>): QuestionMap {
  const questions: Record<string, Question> = {};
  for (const finding of findings) {
    const label = `"${finding.title}" — ${finding.detail}`;
    questions[`f_${finding.id}_class`] = {
      _tag: "choice",
      instructions: `Classify this review finding: ${label}`,
      criteria: CLASS_LEVELS,
    };
    questions[`f_${finding.id}_severity`] = {
      _tag: "score",
      instructions: `How severe is this review finding? ${label}`,
      criteria: ["Negligible", "Minor", "Moderate", "Serious", "Critical"],
    };
    questions[`f_${finding.id}_evidence`] = {
      _tag: "noul",
      instructions: `Does this finding cite specific lines or behavior from the diff? ${label}`,
    };
  }
  questions["review_substantive"] = {
    _tag: "noul",
    instructions: "Did this review examine the actual diff rather than restating the summary?",
  };
  questions["truncated"] = {
    _tag: "noul",
    instructions: "Does the review read as cut off before reaching a verdict?",
  };
  return questions;
}

export interface RoutedFindings {
  readonly blockers: ReadonlyArray<Finding>;
  readonly cosmetic: ReadonlyArray<Finding>;
  readonly questions: ReadonlyArray<Finding>;
  readonly reviewSubstantive: boolean;
  readonly truncated: boolean;
}

const CLASS_CONFIDENCE = 0.6;
/** Severity scores index ["Negligible","Minor","Moderate","Serious","Critical"]. */
const SERIOUS_SEVERITY = 3;
const EVIDENCE_FLOOR = 0.5;

/**
 * Composition policy: a blocker needs a blocking classification (or Serious+
 * severity) *and* cited evidence; low-confidence or unsupported findings go to
 * questions; remaining confident findings are cosmetic.
 */
export function routeTriage(findings: ReadonlyArray<Finding>, answers: AnswerMap): RoutedFindings {
  const blockers: Array<Finding> = [];
  const cosmetic: Array<Finding> = [];
  const questions: Array<Finding> = [];
  for (const finding of findings) {
    const choice = Option.fromUndefinedOr(answers[`f_${finding.id}_class`]).pipe(
      Option.filter(
        (classAnswer): classAnswer is Extract<Answer, { readonly _tag: "choice" }> =>
          classAnswer._tag === "choice",
      ),
    );
    if (Option.isNone(choice) || choice.value.confidence < CLASS_CONFIDENCE) {
      questions.push(finding);
      continue;
    }
    const severity = Option.fromUndefinedOr(answers[`f_${finding.id}_severity`]).pipe(
      Option.filter(
        (severityAnswer): severityAnswer is Extract<Answer, { readonly _tag: "score" }> =>
          severityAnswer._tag === "score",
      ),
      Option.map((severityAnswer) => severityAnswer.score),
      Option.getOrElse(() => 0),
    );
    const evidence = Option.fromUndefinedOr(answers[`f_${finding.id}_evidence`]).pipe(
      Option.filter(
        (evidenceAnswer): evidenceAnswer is Extract<Answer, { readonly _tag: "noul" }> =>
          evidenceAnswer._tag === "noul",
      ),
      Option.map((evidenceAnswer) => evidenceAnswer.noul),
      Option.getOrElse(() => 0),
    );
    if (choice.value.choice === "blocking" || severity >= SERIOUS_SEVERITY) {
      if (evidence >= EVIDENCE_FLOOR) blockers.push(finding);
      else questions.push(finding);
      continue;
    }
    if (choice.value.choice === "cosmetic") {
      cosmetic.push(finding);
      continue;
    }
    questions.push(finding);
  }
  const substantive = Option.fromUndefinedOr(answers["review_substantive"]).pipe(
    Option.filter(
      (answer): answer is Extract<Answer, { readonly _tag: "noul" }> => answer._tag === "noul",
    ),
    Option.map((answer) => answer.noul >= 0.5),
    Option.getOrElse(() => true),
  );
  const truncated = Option.fromUndefinedOr(answers["truncated"]).pipe(
    Option.filter(
      (answer): answer is Extract<Answer, { readonly _tag: "noul" }> => answer._tag === "noul",
    ),
    Option.map((answer) => answer.noul >= 0.5),
    Option.getOrElse(() => false),
  );
  return {
    blockers,
    cosmetic,
    questions,
    reviewSubstantive: substantive,
    truncated,
  };
}
