import type { AnswerMap, QuestionMap } from "../core/schema.ts";

export interface CommitInput {
  readonly message: string;
}

const CONVENTIONAL =
  /^(feat|fix|refactor|test|docs|chore|perf|build|ci)(\([a-z0-9._-]+\))?!?:\s+\S/u;
const SUBJECT_LIMIT = 72;
const NOUL_THRESHOLD = 0.5;

/** Semantic rules go to Jev; format and length rules are code-computed. */
export const commitQuestions = (input: CommitInput): QuestionMap => ({
  explains_why: {
    _tag: "noul",
    instructions: `Does this commit message explain why the change was made (not just what changed)? Message: "${input.message}"`,
  },
  ticket_linked: {
    _tag: "noul",
    instructions: `Does the message reference a ticket or issue id (e.g. IILC-123, #45)? Message: "${input.message}"`,
  },
  test_evidence: {
    _tag: "noul",
    instructions: `Does the message mention tests, checks, or other verification evidence? Message: "${input.message}"`,
  },
  scope_consistent: {
    _tag: "noul",
    instructions: `Does the stated type/scope match the change the message describes? Message: "${input.message}"`,
  },
});

export interface CommitVerdict {
  readonly passed: boolean;
  readonly failed: ReadonlyArray<string>;
}

export function verdictFor(input: {
  readonly message: string;
  readonly answers: AnswerMap;
}): CommitVerdict {
  const [subject = ""] = input.message.split("\n");
  const failed: Array<string> = [];
  if (subject.trim().length === 0) failed.push("subject-missing");
  if (subject.length > SUBJECT_LIMIT) failed.push("subject-too-long");
  if (!CONVENTIONAL.test(subject)) failed.push("format");
  const noulFailed = (key: string): void => {
    const answer = input.answers[key];
    const value = answer?._tag === "noul" ? answer.noul : 0;
    if (value < NOUL_THRESHOLD) failed.push(key);
  };
  noulFailed("explains_why");
  noulFailed("ticket_linked");
  noulFailed("test_evidence");
  noulFailed("scope_consistent");
  return { passed: failed.length === 0, failed };
}
