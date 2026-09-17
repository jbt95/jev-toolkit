import { describe, expect, it } from "vitest";
import { formatAnswers, type AskResult } from "@/core/client.ts";

const result = (answers: AskResult["answers"]): AskResult => ({
  model: "jev-1.13.0",
  answers,
  usage: { input: 10, output: 2 },
});

describe("formatAnswers verdict words", () => {
  it("translates noul probabilities into plain words", () => {
    const text = formatAnswers(
      result({
        a: { _tag: "noul", noul: 0.73 },
        b: { _tag: "noul", noul: 0.51 },
      }),
    );
    expect(text).toContain("a: p(yes)=0.73 — likely yes");
    expect(text).toContain("b: p(yes)=0.51 — toss-up");
  });

  it("resolves a score against its ordered levels", () => {
    const text = formatAnswers(result({ q: { _tag: "score", score: 0.42, confidence: 0.58 } }), {
      q: {
        _tag: "score",
        instructions: "Rate it.",
        criteria: ["misleading — false confidence", "thin — gaps", "adequate — covered"],
      },
    });
    expect(text).toContain("q: 0.42 → between misleading and thin, leans misleading");
  });

  it("flags low-confidence choice and score answers", () => {
    const text = formatAnswers(
      result({
        c: { _tag: "choice", choice: "x", confidence: 0.23, probabilities: {} },
        s: { _tag: "score", score: 1.73, confidence: 0.72 },
      }),
    );
    expect(text).toContain("c: x (confidence 0.23 — LOW, treat as no signal)");
    expect(text).toContain("s: 1.73 (confidence 0.72)");
    expect(text).not.toContain("1.73 — LOW");
  });
});
