import { describe, expect, it } from "vitest";
import {
  failureQuestions,
  identityQuestions,
  transcriptSelectionQuestions,
} from "@/question-packs/failure-triage.ts";

describe("failure triage questions", () => {
  it("asks class, blocks_work, and safe_to_suppress with the failure in the instructions", () => {
    const questions = failureQuestions({ text: "boom", source: "stdin", repeats: 2 });
    expect(Object.keys(questions).sort()).toEqual(["blocks_work", "class", "safe_to_suppress"]);
    const classQuestion = questions["class"];
    if (classQuestion?._tag !== "choice") throw new Error("expected a choice question");
    expect(classQuestion.instructions).toContain("boom");
    expect(classQuestion.instructions).toContain("seen 2 time(s)");
    expect(Object.keys(classQuestion.criteria)).toContain("flake");
  });

  it("builds identity choices from recent failures plus none", () => {
    const questions = identityQuestions({
      current: "Text file busy (retry)",
      recent: [
        { fingerprint: "aaa", sample: "Text file busy" },
        { fingerprint: "bbb", sample: "DNS lookup failed" },
      ],
    });
    const same = questions["same_as"];
    if (same?._tag !== "choice") throw new Error("expected a choice question");
    expect(Object.keys(same.criteria)).toEqual(["recent_0", "recent_1", "none"]);
    expect(same.instructions).toContain("Text file busy (retry)");
  });

  it("builds transcript selection choices plus none", () => {
    const questions = transcriptSelectionQuestions({
      candidates: ["make: missing separator", "exit code 1"],
    });
    const selection = questions["failure_index"];
    if (selection?._tag !== "choice") throw new Error("expected a choice question");
    expect(Object.keys(selection.criteria)).toEqual(["candidate_0", "candidate_1", "none"]);
    expect(selection.criteria["candidate_0"]).toContain("missing separator");
  });
});
