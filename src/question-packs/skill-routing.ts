import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { choiceOf, noulValue, scoreValue } from "../core/answers.ts";
import { type JevClientService, type JevError } from "../core/client.ts";
import type { SkillCandidate } from "../core/skills.ts";
import type { AnswerMap, Harness, QuestionMap } from "../core/schema.ts";

/**
 * Skill routing: the caller supplies its skill catalog, Jev picks the one that
 * fits the task, and code decides whether the pick clears the floors. The model
 * cannot choose a candidate the caller omitted, so code owns the catalog.
 */

/** A skill must be at least this certain before code loads it. */
export const SKILL_CONFIDENCE_FLOOR = 0.5;
/** Below this dependence the skill costs more context than it returns. */
export const SKILL_DEPENDENCE_FLOOR = 2;

/** The option that answers "no skill fits this task". */
export const NO_SKILL = "none";

const NO_SKILL_DESCRIPTION = "no skill applies; general instructions are enough";

/** Criterion text is one compact line: long descriptions dilute the comparison. */
const CRITERION_CHARS = 240;

const criterion = (description: string): string =>
  description.replace(/\s+/gu, " ").trim().slice(0, CRITERION_CHARS);

export interface SkillRouteInput {
  readonly task: string;
  readonly candidates: ReadonlyArray<SkillCandidate>;
}

const DEPENDENCE_LEVELS = [
  "the skill adds little; general instructions would do",
  "the skill helps, but the task is mostly ordinary work",
  "the skill changes how the task is done",
  "the skill carries the task; without it the result would likely be wrong",
  "the task is meaningless without the skill",
];

/** One choice over the catalog plus a second-skill gate and a dependence score. */
export const skillRouteQuestions = (input: SkillRouteInput): QuestionMap =>
  ({
    skill: {
      _tag: "choice",
      instructions:
        `Which one skill should load for the task below? Answer "${NO_SKILL}" when no skill fits ` +
        `better than working from general instructions.\n\ntask: ${input.task}`,
      criteria: Object.fromEntries([
        ...input.candidates.map((candidate) => [candidate.name, criterion(candidate.description)]),
        [NO_SKILL, NO_SKILL_DESCRIPTION],
      ]),
    },
    second: {
      _tag: "noul",
      instructions:
        "Does this task also need a second skill beyond the closest one? " +
        `Answer no when one skill covers it.\n\ntask: ${input.task}`,
      criteria: { true: "a second skill adds value", false: "one skill is enough" },
    },
    dependence: {
      _tag: "score",
      instructions:
        "How much does this task depend on loading the right skill rather than working from " +
        `general instructions?\n\ntask: ${input.task}`,
      criteria: DEPENDENCE_LEVELS,
    },
  }) satisfies QuestionMap;

export interface SkillRouteFloors {
  readonly confidence: number;
  readonly dependence: number;
}

const DEFAULT_FLOORS: SkillRouteFloors = {
  confidence: SKILL_CONFIDENCE_FLOOR,
  dependence: SKILL_DEPENDENCE_FLOOR,
};

export type SkillRouteReason = "no-match" | "low-confidence" | "low-dependence" | "unknown-skill";

export type SkillRoute =
  | {
      readonly _tag: "routed";
      readonly skill: string;
      readonly confidence: number;
      readonly dependence: number;
      readonly secondNeeded: boolean;
    }
  | {
      readonly _tag: "none";
      readonly reason: SkillRouteReason;
      readonly confidence: number;
      readonly dependence: number;
    };

/**
 * Apply the routing policy to the answers. A pick is used only when it names a
 * real candidate, clears the confidence floor, and clears the dependence floor;
 * everything else reports why it did not route.
 */
export const skillRoute = (
  input: SkillRouteInput,
  answers: AnswerMap,
  floors: SkillRouteFloors = DEFAULT_FLOORS,
): SkillRoute => {
  const chosen = choiceOf(answers, "skill").pipe(
    Option.map((answer) => [answer.choice, answer.confidence] as const),
  );
  if (Option.isNone(chosen)) {
    return {
      _tag: "none",
      reason: "no-match",
      confidence: 0,
      dependence: scoreValue(answers, "dependence"),
    };
  }
  const [name, pickConfidence] = chosen.value;
  const dependence = scoreValue(answers, "dependence");
  if (name === NO_SKILL) {
    return { _tag: "none", reason: "no-match", confidence: pickConfidence, dependence };
  }
  if (!input.candidates.some((candidate) => candidate.name === name)) {
    return { _tag: "none", reason: "unknown-skill", confidence: pickConfidence, dependence };
  }
  if (pickConfidence < floors.confidence) {
    return { _tag: "none", reason: "low-confidence", confidence: pickConfidence, dependence };
  }
  if (dependence < floors.dependence) {
    return { _tag: "none", reason: "low-dependence", confidence: pickConfidence, dependence };
  }
  return {
    _tag: "routed",
    skill: name,
    confidence: pickConfidence,
    dependence,
    secondNeeded: noulValue(answers, "second") >= 0.5,
  };
};

/** The catalog a follow-up ask sees: everything except the skill already chosen. */
export const remainingCandidates = (
  input: SkillRouteInput,
  chosen: string,
): ReadonlyArray<SkillCandidate> =>
  input.candidates.filter((candidate) => candidate.name !== chosen);

/**
 * A second, deliberately bounded selection. It runs only when the first gate
 * says another skill helps: one more choice over the remaining candidates with
 * no further "second" question, so a chain never grows past two.
 */
export const skillFollowUpQuestions = (input: SkillRouteInput, chosen: string): QuestionMap => {
  const remaining = remainingCandidates(input, chosen);
  return {
    skill: {
      _tag: "choice",
      instructions:
        `Which additional skill should also load for the task, given that "${chosen}" was ` +
        `chosen first? Answer "${NO_SKILL}" when no further skill adds value.\n\n` +
        `task: ${input.task}`,
      criteria: Object.fromEntries([
        ...remaining.map((candidate) => [candidate.name, criterion(candidate.description)]),
        [NO_SKILL, NO_SKILL_DESCRIPTION],
      ]),
    },
    dependence: {
      _tag: "score",
      instructions:
        "How much does this task depend on loading this additional skill rather than working " +
        `from general instructions?\n\ntask: ${input.task}`,
      criteria: DEPENDENCE_LEVELS,
    },
  } satisfies QuestionMap;
};

/**
 * Evaluate a follow-up pick with the same policy as the first: a name outside
 * the remaining catalog, `none`, low confidence, and low dependence all
 * decline. The follow-up ask carries no `second` gate, which this policy reads
 * as "no".
 */
export const skillFollowUp = (
  input: SkillRouteInput,
  chosen: string,
  answers: AnswerMap,
  floors: SkillRouteFloors = DEFAULT_FLOORS,
): SkillRoute =>
  skillRoute({ task: input.task, candidates: remainingCandidates(input, chosen) }, answers, floors);

/** The ordered chain a routed decision loads: the first pick plus a routed follow-up. */
export const skillChain = (
  route: SkillRoute,
  followUp: SkillRoute | undefined,
): ReadonlyArray<string> =>
  route._tag === "routed"
    ? [route.skill, ...(followUp?._tag === "routed" ? [followUp.skill] : [])]
    : [];

export interface SkillFollowUpPlan {
  readonly second?: SkillRoute;
  readonly usage?: { readonly input: number; readonly output: number };
  /** The typed failure of the follow-up ask; callers format it at their boundary. */
  readonly error?: JevError;
}

/**
 * The optional second selection, shared by every surface: one more question set
 * over the candidates the first pick did not consume. A failed follow-up keeps
 * the first route usable and reports why the second is missing instead of
 * failing the whole call.
 */
export const planSkillFollowUp = (
  ask: JevClientService["ask"],
  harness: Harness,
  input: SkillRouteInput,
  first: SkillRoute,
): Effect.Effect<SkillFollowUpPlan> =>
  Effect.gen(function* planSkillFollowUpProgram() {
    if (first._tag !== "routed" || !first.secondNeeded) return {};
    const remaining = remainingCandidates(input, first.skill);
    if (remaining.length === 0) return {};
    const outcome = yield* Effect.result(
      ask({
        harness,
        state: {
          task: input.task,
          skills: remaining.map((candidate) => ({
            name: candidate.name,
            description: candidate.description,
          })),
        },
        questions: skillFollowUpQuestions(input, first.skill),
        purpose: "route",
      }),
    );
    if (outcome._tag === "Failure") return { error: outcome.failure };
    return {
      second: skillFollowUp(input, first.skill, outcome.success.answers),
      usage: outcome.success.usage,
    };
  });
