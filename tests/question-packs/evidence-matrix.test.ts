import { describe, expect, it } from "vitest";
import type { AnswerMap } from "@/core/schema.ts";
import {
  VERDICT_CONFIDENCE_FLOOR,
  claimNumbers,
  claimVerdicts,
  evidenceQuestions,
  numbersMissingFromEvidence,
} from "@/question-packs/evidence-matrix.ts";

describe("evidence matrix", () => {
  it("extracts distinct numeric tokens from a claim", () => {
    expect(claimNumbers("2 of 3 tests pass at 90%, and 2 retries")).toEqual(["2", "3", "90%"]);
  });

  it("reports claim numbers absent from the evidence", () => {
    expect(numbersMissingFromEvidence("coverage is 90%", "coverage: 82%")).toEqual(["90%"]);
    expect(numbersMissingFromEvidence("2 tests pass", "tests passed: 2")).toEqual([]);
  });

  it("asks one verdict question per claim", () => {
    const questions = evidenceQuestions({
      claims: [
        { id: "c0", text: "first" },
        { id: "c1", text: "second" },
      ],
      evidence: "evidence",
    });

    expect(Object.keys(questions)).toEqual(["c0_verdict", "c1_verdict"]);
    expect(questions["c0_verdict"]?._tag).toBe("choice");
  });

  it("maps answers to verdicts and fails closed without an answer", () => {
    const input = {
      claims: [
        { id: "c0", text: "coverage is 90%" },
        { id: "c1", text: "all tests pass" },
      ],
      evidence: "coverage: 82%",
    };
    const answers: AnswerMap = {
      c0_verdict: { _tag: "choice", choice: "supported", confidence: 0.8, probabilities: {} },
    };

    const verdicts = claimVerdicts(answers, input);

    expect(verdicts[0]?.verdict).toBe("supported");
    // The evidence lacks the claimed number, so the verdict needs evidence regardless.
    expect(verdicts[0]?.needsEvidence).toBe(true);
    expect(verdicts[1]?.verdict).toBe("insufficient");
    expect(verdicts[1]?.confidence).toBe(0);
  });

  it("flags low-confidence verdicts as needing more evidence", () => {
    const input = { claims: [{ id: "c0", text: "all tests pass" }], evidence: "tests passed" };
    const answers: AnswerMap = {
      c0_verdict: { _tag: "choice", choice: "supported", confidence: 0.4, probabilities: {} },
    };

    expect(claimVerdicts(answers, input)[0]?.needsEvidence).toBe(true);
    expect(VERDICT_CONFIDENCE_FLOOR).toBe(0.6);
  });
});
