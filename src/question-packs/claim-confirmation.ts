import { indexedAbove } from "../core/answers.ts";
import type { AnswerMap, Question, QuestionMap } from "../core/schema.ts";

/** The regex candidate generator stays; this gate removes its false positives. */
export const CONFIRM_THRESHOLD = 0.5;

export interface ClaimCandidate {
  readonly id: string;
  readonly matchedText: string;
}

/** One noul per candidate; batched candidates share the state. */
export const claimConfirmQuestions = (candidates: ReadonlyArray<ClaimCandidate>): QuestionMap => {
  const questions: Record<string, Question> = {};
  candidates.forEach((candidate, index) => {
    questions[`c${index}`] = {
      _tag: "noul",
      instructions:
        `Does candidates[${index}].context assert a quantitative claim, ranking, or choice that the agent should ` +
        `have routed through a decision model? Ignore code, dates, version numbers, boilerplate, and hypotheticals. ` +
        `The regex matched "${candidate.matchedText}".`,
    };
  });
  return questions;
};

export const confirmedIndexes = (
  answers: AnswerMap,
  count: number,
  threshold = CONFIRM_THRESHOLD,
): ReadonlyArray<number> => indexedAbove(answers, "c", count, threshold);
