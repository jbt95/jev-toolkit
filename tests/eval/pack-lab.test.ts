import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type { AskResult } from "@/core/client.ts";
import type { AnswerMap } from "@/core/schema.ts";
import { runPackLab, type PackAsk } from "@/eval/pack-lab.ts";
import { writeTempFile } from "../helpers.ts";

const askResult = (answers: AnswerMap): AskResult => ({
  model: "jev-test",
  answers,
  usage: { input: 7, output: 3 },
});

const reviewerAnswers = (noul: number): AnswerMap => ({
  f_f1_class: { _tag: "choice", choice: "blocking", confidence: 0.9, probabilities: {} },
  f_f1_severity: { _tag: "score", score: 3, confidence: 0.8 },
  f_f1_evidence: { _tag: "noul", noul },
  review_substantive: { _tag: "noul", noul: 0.9 },
  truncated: { _tag: "noul", noul: 0.1 },
});

const reviewerFixture = async (): Promise<string> =>
  writeTempFile(
    "fixtures.json",
    JSON.stringify({
      pack: "reviewer",
      cases: [
        {
          id: "r1",
          input: { findings: [{ id: "f1", title: "leak", detail: "detail" }] },
          expected: { blockers: 1, cosmetic: 0, questions: 0 },
        },
      ],
    }),
  );

describe("pack lab", () => {
  it("replays a fixture and reports agreement, tokens, and latency", async () => {
    const fixturePath = await reviewerFixture();
    const ask: PackAsk = () => Effect.succeed(askResult(reviewerAnswers(0.9)));

    const report = await Effect.runPromise(runPackLab({ fixturePath, repeat: 1 }, ask, "script"));

    expect(report.pack).toBe("reviewer");
    expect(report.compared).toBe(1);
    expect(report.agreed).toBe(1);
    expect(report.cases[0]?.summary).toMatchObject({ blockers: 1, cosmetic: 0, questions: 0 });
    expect(report.cases[0]?.agreed).toBe(true);
    expect(report.cases[0]?.maxSpread).toBe(0);
    expect(report.cases[0]?.meanConfidence).toBeCloseTo(0.85, 5);
    expect(report.inputTokens).toBe(7);
    expect(report.outputTokens).toBe(3);
  });

  it("exposes answer drift across identical repeats", async () => {
    const fixturePath = await reviewerFixture();
    let calls = 0;
    const ask: PackAsk = () => {
      calls += 1;
      return Effect.succeed(askResult(reviewerAnswers(calls % 2 === 0 ? 0.9 : 0.4)));
    };

    const report = await Effect.runPromise(runPackLab({ fixturePath, repeat: 2 }, ask, "script"));

    expect(report.cases[0]?.unstableAnswers).toContain("f_f1_evidence");
    expect(report.cases[0]?.maxSpread).toBeCloseTo(0.5, 5);
  });

  it("reports a missing fixture file as a typed failure", async () => {
    const outcome = await Effect.runPromise(
      Effect.result(
        runPackLab(
          { fixturePath: "/nonexistent/fixtures.json", repeat: 1 },
          () => Effect.never,
          "script",
        ),
      ),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      expect(outcome.failure.reason).toContain("cannot read fixtures");
    }
  });

  it("rejects an invalid fixture file", async () => {
    const fixturePath = await writeTempFile("bad.json", JSON.stringify({ pack: "nope" }));
    const outcome = await Effect.runPromise(
      Effect.result(runPackLab({ fixturePath, repeat: 1 }, () => Effect.never, "script")),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      expect(outcome.failure.reason).toContain("invalid fixture file");
    }
  });

  it("fails a case whose input does not match the pack", async () => {
    const fixturePath = await writeTempFile(
      "mismatch.json",
      JSON.stringify({ pack: "commit", cases: [{ id: "c1", input: { nope: true } }] }),
    );
    const outcome = await Effect.runPromise(
      Effect.result(runPackLab({ fixturePath, repeat: 1 }, () => Effect.never, "script")),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      expect(outcome.failure.reason).toContain("case c1");
    }
  });
});
