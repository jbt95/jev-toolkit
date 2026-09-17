import type { QuestionMap } from "../core/schema.ts";
import { clip, redact } from "../core/text.ts";

export interface FailureInput {
  readonly text: string;
  readonly source: string;
  readonly repeats: number;
}

export function failureQuestions(input: FailureInput): QuestionMap {
  const failure = clip(redact(input.text));
  return {
    class: {
      _tag: "choice",
      instructions: `Classify this failure (source: ${input.source}, seen ${input.repeats} time(s)): "${failure}"`,
      criteria: {
        env_or_config: "missing env var, bad config, missing file or install",
        flake: "transient; a retry may pass",
        product_bug: "code defect",
        security_finding: "security or secret exposure",
        unknown: "cannot classify",
      },
    },
    blocks_work: {
      _tag: "noul",
      instructions: "Does this failure block the current work until it is resolved?",
    },
    safe_to_suppress: {
      _tag: "noul",
      instructions: "Is suppressing this failure for the current session safe and reversible?",
    },
  };
}

export interface FailureIdentityInput {
  readonly current: string;
  readonly recent: ReadonlyArray<{ readonly fingerprint: string; readonly sample: string }>;
}

/**
 * Hash misses usually mean wording drift, not a new problem. This selection
 * lets the loop breaker count a drifted failure against its earlier record.
 */
export function identityQuestions(input: FailureIdentityInput): QuestionMap {
  const criteria: Record<string, string> = {};
  input.recent.forEach((entry, index) => {
    criteria[`recent_${index}`] = `same as: "${entry.sample.slice(0, 120)}"`;
  });
  criteria["none"] = "a new, distinct failure";
  return {
    same_as: {
      _tag: "choice",
      instructions:
        `Is the current failure the same underlying issue as any recently seen failure? ` +
        `Current: "${input.current.slice(0, 300)}"`,
      criteria,
    },
  };
}

export interface TranscriptSelectionInput {
  readonly candidates: ReadonlyArray<string>;
}

/** Pick which prefiltered transcript snippet is the failure the turn ended on. */
export function transcriptSelectionQuestions(input: TranscriptSelectionInput): QuestionMap {
  const criteria: Record<string, string> = {};
  input.candidates.forEach((text, index) => {
    criteria[`candidate_${index}`] = text.slice(0, 140);
  });
  criteria["none"] = "none of these is a failure";
  return {
    failure_index: {
      _tag: "choice",
      instructions:
        "Which candidate snippet is the failure that ended the turn? " +
        "Answer none when none of them reports a failure.",
      criteria,
    },
  };
}
