import type { AnswerMap } from "./schema.ts";

/** Noul probability under `key`, or 0 when absent or a different primitive. */
export const noulValue = (answers: AnswerMap, key: string): number => {
  const answer = answers[key];
  return answer?._tag === "noul" ? answer.noul : 0;
};

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
