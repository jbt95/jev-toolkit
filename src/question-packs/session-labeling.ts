import * as Option from "effect/Option";
import type { SessionDigest } from "../audit/sessions.ts";
import type { Question, QuestionMap } from "../core/schema.ts";

const TASK_TYPES = {
  feature: "new capability",
  fix: "bug fix",
  review: "review or verification",
  analysis: "investigation or measurement",
  release: "release or integration",
  content: "docs or content",
  other: "other",
} as const;

/** Per digest: outcome, friction, waste, task type. */
export function labelQuestions(digests: ReadonlyArray<SessionDigest>): QuestionMap {
  const questions: Record<string, Question> = {};
  digests.forEach((digest, index) => {
    const cost = Option.fromUndefinedOr(digest.costUsd).pipe(
      Option.map((value) => `cost $${value.toFixed(2)}`),
      Option.toArray,
    );
    const parts = [
      `Session ${index + 1} (${digest.harness}): ${digest.assistantTurns} assistant turns`,
      `tools ${JSON.stringify(digest.toolCounts)}`,
      `tool errors ${digest.errorCount}`,
      `turn endings ${JSON.stringify(digest.stopReasons ?? {})}`,
      ...cost,
    ];
    const label =
      `${parts.join("; ")}; the developer asked: ` +
      `${digest.userPrompts.join(" | ") || "(no captured prompts)"}`;
    questions[`s${index}_outcome`] = {
      _tag: "choice",
      instructions: `What was the outcome of this session? ${label}`,
      criteria: {
        shipped: "work completed and delivered",
        blocked: "stopped by an unresolved blocker",
        abandoned: "left unfinished without resolution",
        ongoing: "still in progress",
      },
    };
    questions[`s${index}_friction`] = {
      _tag: "score",
      instructions: `How much friction did the developer hit in this session? ${label}`,
      criteria: ["None", "Minor", "Noticeable", "High", "Severe"],
    };
    questions[`s${index}_waste`] = {
      _tag: "choice",
      instructions: `What waste pattern dominated this session, if any? ${label}`,
      criteria: {
        none: "no notable waste",
        loop: "repeated failing attempts at the same thing",
        truncation: "stopped at a limit before finishing",
        retries: "repeated retries of the same action",
        waiting_on_human: "idled waiting for the developer",
      },
    };
    questions[`s${index}_task_type`] = {
      _tag: "choice",
      instructions: `What kind of work did this session cover? ${label}`,
      criteria: TASK_TYPES,
    };
  });
  return questions;
}
