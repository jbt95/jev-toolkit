import { noulValue } from "../core/answers.ts";
import type { AnswerMap, Question, QuestionMap } from "../core/schema.ts";

export interface CommitInput {
  /** Redacted and clipped by the caller. */
  readonly message: string;
  /** The repository's documented commit spec, when one exists (clipped by the caller). */
  readonly spec?: string;
}

const CONVENTIONAL =
  /^(feat|fix|refactor|test|docs|chore|perf|build|ci)(\([a-z0-9._-]+\))?!?:\s+\S/u;
const SUBJECT_LIMIT = 72;
const NOUL_THRESHOLD = 0.5;
const PROFILE_THRESHOLD = 0.5;

export const COMMIT_RULES = [
  "explains_why",
  "ticket_linked",
  "test_evidence",
  "scope_consistent",
] as const;
export type CommitRule = (typeof COMMIT_RULES)[number];

const RULE_INSTRUCTIONS: Record<CommitRule, string> = {
  explains_why: "explain why the change was made (not just what changed)",
  ticket_linked: "reference a ticket or issue id (e.g. IILC-123, #45)",
  test_evidence: "mention tests, checks, or other verification evidence",
  scope_consistent: "keep the stated type and scope consistent with the change",
};

/**
 * With `spec` present, `p_<rule>` questions read which rules the repo's spec
 * actually imposes; per-commit rule questions judge the message against it.
 * Code ignores answers for rules the profile marks as not required.
 */
export const commitQuestions = (input: CommitInput): QuestionMap => {
  const questions: Record<string, Question> = {};
  if (input.spec !== undefined) {
    for (const rule of COMMIT_RULES) {
      questions[`p_${rule}`] = {
        _tag: "noul",
        instructions: `Does \`spec\` require commit messages to ${RULE_INSTRUCTIONS[rule]}? Answer no when the spec is silent or optional about it.`,
      };
    }
  }
  for (const rule of COMMIT_RULES) {
    questions[rule] = {
      _tag: "noul",
      instructions:
        `Does this commit message ${RULE_INSTRUCTIONS[rule]}?` +
        (input.spec === undefined ? "" : " Judge it against the documented spec in `spec`.") +
        ` Message: "${input.message}"`,
    };
  }
  return questions;
};

export interface CommitVerdict {
  readonly passed: boolean;
  readonly failed: ReadonlyArray<string>;
}

export function verdictFor(input: {
  readonly message: string;
  readonly answers: AnswerMap;
  /** Answer map containing the `p_<rule>` profile questions, when a spec was provided. */
  readonly profile?: AnswerMap;
}): CommitVerdict {
  const [subject = ""] = input.message.split("\n");
  const failed: Array<string> = [];
  if (subject.trim().length === 0) failed.push("subject-missing");
  if (subject.length > SUBJECT_LIMIT) failed.push("subject-too-long");
  if (!CONVENTIONAL.test(subject)) failed.push("format");
  for (const rule of COMMIT_RULES) {
    if (input.profile !== undefined && noulValue(input.profile, `p_${rule}`) < PROFILE_THRESHOLD) {
      continue;
    }
    if (noulValue(input.answers, rule) < NOUL_THRESHOLD) failed.push(rule);
  }
  return { passed: failed.length === 0, failed };
}
