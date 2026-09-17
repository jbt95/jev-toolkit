import { describe, expect, it } from "vitest";
import type { AnswerMap } from "@/core/schema.ts";
import { alignedIndexes, claimAlignmentQuestions } from "@/question-packs/claim-alignment.ts";

describe("claim alignment", () => {
  it("asks one noul per claim and references sessionQuestions", () => {
    const questions = claimAlignmentQuestions([
      { id: "a0", matchedText: "likely" },
      { id: "a1", matchedText: "rank" },
    ]);
    expect(Object.keys(questions)).toHaveLength(2);
    if (questions["a0"]?._tag === "noul") {
      expect(questions["a0"].instructions).toContain("`sessionQuestions`");
      expect(questions["a0"].instructions).toContain('"likely"');
    }
  });

  it("keeps only aligned claims above the threshold", () => {
    const answers: AnswerMap = {
      a0: { _tag: "noul", noul: 0.8 },
      a1: { _tag: "noul", noul: 0.5 },
    };
    expect(alignedIndexes(answers, 2)).toEqual([0, 1]);
    expect(alignedIndexes({ a0: { _tag: "noul", noul: 0.2 } }, 2)).toEqual([]);
  });
});
