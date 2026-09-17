import { describe, expect, it } from "vitest";
import type { AnswerMap } from "@/core/schema.ts";
import { reviewQuestions, routeTriage, type Finding } from "@/question-packs/reviewer-triage.ts";

const findings: ReadonlyArray<Finding> = [
  {
    id: "f1",
    title: "Missing null check",
    detail: "The handler dereferences user.profile without checking for null.",
    file: "src/handler.ts",
    line: 42,
  },
  { id: "f2", title: "Import order", detail: "Imports are not sorted alphabetically." },
];

describe("reviewer triage", () => {
  it("asks three questions per finding plus two review gates", () => {
    const questions = reviewQuestions(findings);
    expect(Object.keys(questions)).toHaveLength(findings.length * 3 + 2);
    expect(questions["f_f1_class"]?._tag).toBe("choice");
    expect(questions["f_f1_severity"]?._tag).toBe("score");
    expect(questions["f_f1_evidence"]?._tag).toBe("noul");
    expect(questions["review_substantive"]?._tag).toBe("noul");
    expect(questions["truncated"]?._tag).toBe("noul");
  });

  it("routes blockers, cosmetics, and low-confidence answers", () => {
    const answers: AnswerMap = {
      f_f1_class: {
        _tag: "choice",
        choice: "blocking",
        confidence: 0.9,
        probabilities: { blocking: 0.9 },
      },
      f_f2_class: {
        _tag: "choice",
        choice: "cosmetic",
        confidence: 0.5,
        probabilities: { cosmetic: 0.5 },
      },
      review_substantive: { _tag: "noul", noul: 0.9 },
      truncated: { _tag: "noul", noul: 0.8 },
    };

    const routed = routeTriage(findings, answers);

    expect(routed.blockers.map((finding) => finding.id)).toEqual(["f1"]);
    expect(routed.cosmetic).toEqual([]);
    expect(routed.questions.map((finding) => finding.id)).toEqual(["f2"]);
    expect(routed.reviewSubstantive).toBe(true);
    expect(routed.truncated).toBe(true);
  });
});
