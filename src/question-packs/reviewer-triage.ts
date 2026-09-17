import * as Schema from "effect/Schema";
import type { AnswerMap, Question, QuestionMap } from "../core/schema.ts";

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

/** Class answers below 0.6 confidence route to the questions bucket. */
export function routeTriage(findings: ReadonlyArray<Finding>, answers: AnswerMap): RoutedFindings {
  const blockers: Array<Finding> = [];
  const cosmetic: Array<Finding> = [];
  const questions: Array<Finding> = [];
  for (const finding of findings) {
    const answer = answers[`f_${finding.id}_class`];
    const choice = answer?._tag === "choice" ? answer : undefined;
    if (choice !== undefined && choice.confidence >= 0.6) {
      if (choice.choice === "blocking") {
        blockers.push(finding);
        continue;
      }
      if (choice.choice === "cosmetic") {
        cosmetic.push(finding);
        continue;
      }
    }
    questions.push(finding);
  }
  const substantive = answers["review_substantive"];
  const truncatedAnswer = answers["truncated"];
  return {
    blockers,
    cosmetic,
    questions,
    reviewSubstantive: substantive?._tag === "noul" ? substantive.noul >= 0.5 : true,
    truncated: truncatedAnswer?._tag === "noul" ? truncatedAnswer.noul >= 0.5 : false,
  };
}
