import * as Option from "effect/Option";
import type { Answer, AnswerMap } from "./schema.ts";

/** Noul probability under `key`, or 0 when absent or a different primitive. */
export const noulValue = (answers: AnswerMap, key: string): number =>
  Option.fromUndefinedOr(answers[key]).pipe(
    Option.filter(
      (answer): answer is Extract<Answer, { readonly _tag: "noul" }> => answer._tag === "noul",
    ),
    Option.map((answer) => answer.noul),
    Option.getOrElse(() => 0),
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
