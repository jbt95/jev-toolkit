import * as Option from "effect/Option";
import { choiceOf } from "../core/answers.ts";
import type { AnswerMap, Question, QuestionMap } from "../core/schema.ts";

/** Verdicts a claim can receive from the evidence matrix. */
export const CLAIM_VERDICTS = ["supported", "contradicted", "unrelated", "insufficient"] as const;
export type ClaimVerdict = (typeof CLAIM_VERDICTS)[number];

/**
 * A verdict only drives action above this confidence; below it the caller
 * should collect more evidence rather than act. Code applies the policy.
 */
export const VERDICT_CONFIDENCE_FLOOR = 0.6;

export interface EvidenceClaim {
  readonly id: string;
  readonly text: string;
}

export interface EvidenceInput {
  /** Claims the caller is about to publish, already redacted and clipped. */
  readonly claims: ReadonlyArray<EvidenceClaim>;
  /** Evidence text the claims are checked against, already redacted and clipped. */
  readonly evidence: string;
}

const NUMBER_PATTERN = /\b\d+(?:\.\d+)?%?/gu;

/** Distinct numeric tokens a claim asserts, in first-seen order. */
export const claimNumbers = (text: string): ReadonlyArray<string> => [
  ...new Set(text.match(NUMBER_PATTERN) ?? []),
];

/** Numbers in the claim that do not appear verbatim in the evidence text. */
export const numbersMissingFromEvidence = (
  claim: string,
  evidence: string,
): ReadonlyArray<string> => claimNumbers(claim).filter((number) => !evidence.includes(number));

/**
 * The deterministic side of verification: code reports which claim numbers the
 * evidence does not contain, then Jev judges the semantic relation. Both are
 * present in the state, so the judgment is anchored in observed facts.
 */
export const evidenceQuestions = (input: EvidenceInput): QuestionMap => {
  const questions: Record<string, Question> = {};
  input.claims.forEach((claim, index) => {
    questions[`c${index}_verdict`] = {
      _tag: "choice",
      instructions:
        `Does \`evidence\` support \`claims[${index}].text\`? Judge only from the evidence and the ` +
        `deterministic notes in \`missingNumbers[${index}]\`. Answer supported when the evidence states ` +
        `or directly entails the claim, contradicted when it states the opposite, unrelated when it is ` +
        `about a different subject, and insufficient when the evidence cannot decide.`,
      criteria: {
        supported: "the evidence states or directly entails what the claim asserts",
        contradicted: "the evidence states the opposite of the claim",
        unrelated: "the evidence is about a different subject",
        insufficient: "the evidence cannot decide the claim",
      },
    };
  });
  return questions;
};

export interface ClaimVerdictResult {
  readonly id: string;
  readonly claim: string;
  readonly verdict: ClaimVerdict;
  readonly confidence: number;
  readonly missingNumbers: ReadonlyArray<string>;
  /** True when the verdict itself is weak or the evidence lacks claimed numbers. */
  readonly needsEvidence: boolean;
}

export interface VerdictAnswer {
  readonly verdict: ClaimVerdict;
  readonly confidence: number;
}

const verdictOf = (answers: AnswerMap, key: string): VerdictAnswer =>
  choiceOf(answers, key).pipe(
    Option.flatMap((choice) =>
      Option.fromUndefinedOr(CLAIM_VERDICTS.find((candidate) => candidate === choice.choice)).pipe(
        Option.map((verdict) => ({ verdict, confidence: choice.confidence })),
      ),
    ),
    Option.getOrElse((): VerdictAnswer => ({
      verdict: "insufficient",
      confidence: 0,
    })),
  );

/** One verdict per claim; missing answers fail closed to `insufficient`. */
export const claimVerdicts = (
  answers: AnswerMap,
  input: EvidenceInput,
): ReadonlyArray<ClaimVerdictResult> =>
  input.claims.map((claim, index) => {
    const answer = verdictOf(answers, `c${index}_verdict`);
    const missingNumbers = numbersMissingFromEvidence(claim.text, input.evidence);
    return {
      id: claim.id,
      claim: claim.text,
      verdict: answer.verdict,
      confidence: answer.confidence,
      missingNumbers,
      needsEvidence:
        answer.verdict === "insufficient" ||
        answer.confidence < VERDICT_CONFIDENCE_FLOOR ||
        missingNumbers.length > 0,
    };
  });
