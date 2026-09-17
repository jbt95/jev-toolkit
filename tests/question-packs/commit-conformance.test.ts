import { describe, expect, it } from "vitest";
import type { AnswerMap } from "@/core/schema.ts";
import { commitQuestions, verdictFor } from "@/question-packs/commit-conformance.ts";

const goodMessage =
  "feat(parser): reject mixed-indentation blocks\n\nMixed tabs and spaces made column math wrong, so blocks\nnow fail parsing with a clear error. Covered by parser tests.";

const allPass: AnswerMap = {
  explains_why: { _tag: "noul", noul: 0.9 },
  ticket_linked: { _tag: "noul", noul: 0.9 },
  test_evidence: { _tag: "noul", noul: 0.9 },
  scope_consistent: { _tag: "noul", noul: 0.9 },
};

describe("commit conformance", () => {
  it("asks one semantic question per documented rule", () => {
    const questions = commitQuestions({ message: goodMessage });
    expect(Object.keys(questions)).toHaveLength(4);
    expect(questions["explains_why"]?._tag).toBe("noul");
  });

  it("passes a conventional commit with all semantic rules met", () => {
    expect(verdictFor({ message: goodMessage, answers: allPass })).toEqual({
      passed: true,
      failed: [],
    });
  });

  it("flags format and length violations in code", () => {
    const badFormat = verdictFor({ message: "updated stuff", answers: allPass });
    expect(badFormat.failed).toContain("format");

    const longSubject = `feat: ${"x".repeat(80)}`;
    const tooLong = verdictFor({ message: longSubject, answers: allPass });
    expect(tooLong.failed).toContain("subject-too-long");
  });

  it("flags semantic rules the model rejects", () => {
    const wishyWashy: AnswerMap = {
      ...allPass,
      explains_why: { _tag: "noul", noul: 0.2 },
      ticket_linked: { _tag: "noul", noul: 0.1 },
    };
    const verdict = verdictFor({ message: goodMessage, answers: wishyWashy });
    expect(verdict.passed).toBe(false);
    expect(verdict.failed).toEqual(["explains_why", "ticket_linked"]);
  });
});
