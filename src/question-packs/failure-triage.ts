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
