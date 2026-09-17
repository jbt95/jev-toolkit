import { describe, expect, it } from "vitest";
import type { AnswerMap } from "@/core/schema.ts";
import { claimConfirmQuestions, confirmedIndexes } from "@/question-packs/claim-confirmation.ts";

const candidates = [
  { id: "c0", matchedText: "30%" },
  { id: "c1", matchedText: "best" },
];

describe("claim confirmation", () => {
  it("asks one noul per candidate and references the state path", () => {
    const questions = claimConfirmQuestions(candidates);
    expect(Object.keys(questions)).toHaveLength(2);
    expect(questions["c0"]?._tag).toBe("noul");
    if (questions["c0"]?._tag === "noul") {
      expect(questions["c0"].instructions).toContain("candidates[0].context");
      expect(questions["c0"].instructions).toContain('"30%"');
    }
  });

  it("keeps only candidates above the threshold", () => {
    const answers: AnswerMap = {
      c0: { _tag: "noul", noul: 0.9 },
      c1: { _tag: "noul", noul: 0.4 },
    };
    expect(confirmedIndexes(answers, 2)).toEqual([0]);
  });

  it("treats missing answers as unconfirmed", () => {
    expect(confirmedIndexes({}, 2)).toEqual([]);
  });
});
