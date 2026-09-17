import { describe, expect, it } from "vitest";
import type { AnswerMap } from "@/core/schema.ts";
import {
  REVIEW_DIMENSIONS,
  evaluateReview,
  hasReviewContext,
  normalizeReviewScore,
  reviewQuestions,
  sanitizeReviewInput,
} from "@/question-packs/review-profile.ts";

const answersFor = (overrides: AnswerMap = {}): AnswerMap => {
  const answers: Record<string, AnswerMap[string]> = {};
  for (const dimension of REVIEW_DIMENSIONS) {
    answers[`${dimension}_applicable`] = { _tag: "noul", noul: 0.9 };
    answers[`${dimension}_score`] = { _tag: "score", score: 2, confidence: 0.8 };
  }
  answers["top_weakness"] = {
    _tag: "choice",
    choice: "test_quality",
    confidence: 0.7,
    probabilities: {},
  };
  return { ...answers, ...overrides };
};

describe("review profile", () => {
  it("asks applicability and a score per dimension plus one top-weakness question", () => {
    const questions = reviewQuestions({ diff: "x" });

    expect(Object.keys(questions)).toHaveLength(REVIEW_DIMENSIONS.length * 2 + 1);
    expect(questions["correctness_applicable"]?._tag).toBe("noul");
    expect(questions["correctness_score"]?._tag).toBe("score");
    expect(questions["top_weakness"]?._tag).toBe("choice");
  });

  it("adds direction questions only for dimensions present in the previous evaluation", () => {
    const questions = reviewQuestions({
      diff: "x",
      previousEvaluation: {
        dimensions: [{ dimension: "correctness", applicable: true, score: 1, confidence: 0.8 }],
      },
    });

    expect(questions["correctness_direction"]?._tag).toBe("choice");
    expect(questions["security_direction"]).toBeUndefined();
  });

  it("evaluates gates, scores, directions, and the top weakness", () => {
    const input = {
      diff: "x",
      previousEvaluation: {
        dimensions: [{ dimension: "correctness", applicable: true, score: 1, confidence: 0.8 }],
      },
    };
    const answers = answersFor({
      security_applicable: { _tag: "noul", noul: 0.2 },
      correctness_direction: {
        _tag: "choice",
        choice: "improved",
        confidence: 0.9,
        probabilities: {},
      },
    });

    const outcome = evaluateReview(input, answers);
    const correctness = outcome.dimensions.find((entry) => entry.dimension === "correctness");
    const security = outcome.dimensions.find((entry) => entry.dimension === "security");

    expect(correctness?.score).toBe(2);
    expect(correctness?.direction).toBe("improved");
    expect(security?.applicable).toBe(false);
    expect(outcome.topWeakness).toBe("test_quality");
  });

  it("fails closed when answers are missing", () => {
    const outcome = evaluateReview({ diff: "x" }, {});

    expect(outcome.dimensions.every((entry) => !entry.applicable)).toBe(true);
    expect(outcome.topWeakness).toBe("none_material");
  });

  it("redacts credentials and clips long fields", () => {
    const sanitized = sanitizeReviewInput({
      diff: `Authorization: Bearer abcdef\n${"x".repeat(40000)}`,
    });

    expect(sanitized.diff).toContain("[redacted]");
    expect(sanitized.diff?.endsWith("[clipped]")).toBe(true);
  });

  it("requires some review context", () => {
    expect(hasReviewContext({})).toBe(false);
    expect(hasReviewContext({ task: "add parser" })).toBe(true);
    expect(hasReviewContext({ files: [{ path: "a.ts", content: "x" }] })).toBe(true);
  });

  it("normalizes scores onto 0..1", () => {
    expect(normalizeReviewScore(0)).toBe(0);
    expect(normalizeReviewScore(2)).toBe(0.5);
    expect(normalizeReviewScore(4)).toBe(1);
  });
});
