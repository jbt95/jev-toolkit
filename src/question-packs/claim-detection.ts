import { noulValue } from "../core/answers.ts";
import {
  CLAIM_KINDS,
  type AnswerMap,
  type ClaimKind,
  type Question,
  type QuestionMap,
} from "../core/schema.ts";

/** A detected claim must clear this noul probability. Code applies the policy. */
export const DETECTION_THRESHOLD = 0.5;

export interface ClaimDetectionInput {
  /** How many `messages` entries the state carries. */
  readonly count: number;
  /** Whose text is being judged: an assistant message or a user prompt. */
  readonly subject: "assistant_message" | "user_prompt";
}

const CLAIM_INSTRUCTIONS: Record<ClaimDetectionInput["subject"], (index: number) => string> = {
  assistant_message: (index) =>
    `Does messages[${index}].text assert a quantitative claim, ranking, or choice that the assistant ` +
    `should have routed through a decision model? Ignore code, dates, version numbers, boilerplate, ` +
    `and hypotheticals.`,
  user_prompt: (index) =>
    `Does messages[${index}].text ask for a quantitative estimate, ranking, or choice that the assistant ` +
    `should route through a decision model? Ignore code, dates, version numbers, boilerplate, ` +
    `and hypotheticals.`,
};

const KIND_CRITERIA: Record<ClaimKind | "none", string> = {
  percent: "reports a percentage as evidence or an estimate",
  probability: "states a likelihood, chance, or odds",
  ranking: "ranks, prioritizes, or picks a best/worst/top option",
  estimate: "gives a rough quantity, magnitude, or cost",
  choice: "poses or resolves a choice between options",
  none: "no such claim",
};

/**
 * One batched question set per call: a routing judgment and a kind for each
 * message. The regex no longer decides whether a claim exists — this does.
 */
export const claimDetectionQuestions = (input: ClaimDetectionInput): QuestionMap => {
  const questions: Record<string, Question> = {};
  for (let index = 0; index < input.count; index += 1) {
    questions[`m${index}_claim`] = {
      _tag: "noul",
      instructions: CLAIM_INSTRUCTIONS[input.subject](index),
    };
    questions[`m${index}_kind`] = {
      _tag: "choice",
      instructions:
        `Which kind of claim does messages[${index}].text contain? ` +
        `Answer none when it contains no such claim.`,
      criteria: KIND_CRITERIA,
    };
  }
  return questions;
};

export interface DetectedClaim {
  readonly index: number;
  readonly kind: ClaimKind;
}

/** Indexes (message order) the model routed, with a kind other than none. */
export const detectedClaims = (
  answers: AnswerMap,
  count: number,
  threshold = DETECTION_THRESHOLD,
): ReadonlyArray<DetectedClaim> => {
  const found: Array<DetectedClaim> = [];
  for (let index = 0; index < count; index += 1) {
    if (noulValue(answers, `m${index}_claim`) < threshold) continue;
    const kindAnswer = answers[`m${index}_kind`];
    if (kindAnswer?._tag !== "choice") continue;
    const kind = CLAIM_KINDS.find((candidate) => candidate === kindAnswer.choice);
    if (kind === undefined) continue;
    found.push({ index, kind });
  }
  return found;
};
