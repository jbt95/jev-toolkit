import { indexedAbove } from "../core/answers.ts";
import type { AnswerMap, Question, QuestionMap } from "../core/schema.ts";

/**
 * Session-level co-occurrence is too coarse ("the session had some calls"), so
 * each confirmed claim is aligned against the questions actually asked in its
 * session. Unaligned claims stay unmatched for compliance.
 */
export const ALIGN_THRESHOLD = 0.5;

export interface AlignmentClaim {
  readonly id: string;
  readonly excerpt: string;
}

/** One noul per claim; state carries `sessionQuestions` and `claims`. */
export const claimAlignmentQuestions = (claims: ReadonlyArray<AlignmentClaim>): QuestionMap => {
  const questions: Record<string, Question> = {};
  claims.forEach((claim, index) => {
    questions[`a${index}`] = {
      _tag: "noul",
      instructions:
        `Does at least one question in \`sessionQuestions\` address this claim: "${claim.excerpt}" ` +
        `(found in claims[${index}])? Answer no when the session's questions were about something else.`,
    };
  });
  return questions;
};

export const alignedIndexes = (
  answers: AnswerMap,
  count: number,
  threshold = ALIGN_THRESHOLD,
): ReadonlyArray<number> => indexedAbove(answers, "a", count, threshold);
