import { describe, expect, it } from "vitest";
import { claimDetectionQuestions, detectedClaims } from "@/question-packs/claim-detection.ts";
import type { AnswerMap } from "@/core/schema.ts";

describe("claim detection", () => {
  it("asks a claim noul and a kind choice per message", () => {
    const questions = claimDetectionQuestions({ count: 2, subject: "assistant_message" });
    expect(Object.keys(questions)).toHaveLength(4);
    const claim = questions["m0_claim"];
    if (claim?._tag !== "noul") throw new Error("expected a noul question");
    expect(claim.instructions).toContain("messages[0].text");
    expect(questions["m1_kind"]?._tag).toBe("choice");
  });

  it("uses prompt wording for user prompts", () => {
    const questions = claimDetectionQuestions({ count: 1, subject: "user_prompt" });
    const claim = questions["m0_claim"];
    if (claim?._tag !== "noul") throw new Error("expected a noul question");
    expect(claim.instructions).toContain("ask for");
  });

  it("keeps only routed claims with a known kind", () => {
    const answers: AnswerMap = {
      m0_claim: { _tag: "noul", noul: 0.9 },
      m0_kind: { _tag: "choice", choice: "percent", confidence: 0.9, probabilities: {} },
      m1_claim: { _tag: "noul", noul: 0.9 },
      m1_kind: { _tag: "choice", choice: "none", confidence: 0.9, probabilities: {} },
      m2_claim: { _tag: "noul", noul: 0.2 },
      m2_kind: { _tag: "choice", choice: "ranking", confidence: 0.9, probabilities: {} },
    };
    expect(detectedClaims(answers, 3)).toEqual([{ index: 0, kind: "percent" }]);
  });

  it("treats missing answers as not detected", () => {
    expect(detectedClaims({}, 2)).toEqual([]);
  });
});
