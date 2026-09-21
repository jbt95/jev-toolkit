import * as Option from "effect/Option";
import type { Answer, AnswerMap } from "./schema.ts";

type ChoiceAnswer = Extract<Answer, { readonly _tag: "choice" }>;
type ScoreAnswer = Extract<Answer, { readonly _tag: "score" }>;
type NoulAnswer = Extract<Answer, { readonly _tag: "noul" }>;

const isChoice = (answer: Answer): answer is ChoiceAnswer => answer._tag === "choice";
const isScore = (answer: Answer): answer is ScoreAnswer => answer._tag === "score";
const isNoul = (answer: Answer): answer is NoulAnswer => answer._tag === "noul";

/** The choice answer under `key`, when `key` holds a choice. */
export const choiceOf = (answers: AnswerMap, key: string): Option.Option<ChoiceAnswer> =>
  Option.fromUndefinedOr(answers[key]).pipe(Option.filter(isChoice));

/** The score answer under `key`, when `key` holds a score. */
export const scoreOf = (answers: AnswerMap, key: string): Option.Option<ScoreAnswer> =>
  Option.fromUndefinedOr(answers[key]).pipe(Option.filter(isScore));

/** The noul answer under `key`, when `key` holds a noul. */
export const noulOf = (answers: AnswerMap, key: string): Option.Option<NoulAnswer> =>
  Option.fromUndefinedOr(answers[key]).pipe(Option.filter(isNoul));

/** Noul probability under `key`, or 0 when absent or a different primitive. */
export const noulValue = (answers: AnswerMap, key: string): number =>
  noulOf(answers, key).pipe(
    Option.map((answer) => answer.noul),
    Option.getOrElse(() => 0),
  );

/** Score under `key`, or `fallback` when absent or a different primitive. */
export const scoreValue = (answers: AnswerMap, key: string, fallback = 0): number =>
  scoreOf(answers, key).pipe(
    Option.map((answer) => answer.score),
    Option.getOrElse(() => fallback),
  );

/** Indexes whose `<prefix><index>` noul answer clears `threshold`. */
export const indexedAbove = (
  answers: AnswerMap,
  prefix: string,
  count: number,
  threshold: number,
): ReadonlyArray<number> => {
  const kept: Array<number> = [];
  for (let index = 0; index < count; index += 1) {
    if (noulValue(answers, `${prefix}${index}`) >= threshold) kept.push(index);
  }
  return kept;
};
