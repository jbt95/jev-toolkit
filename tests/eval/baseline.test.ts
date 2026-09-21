import { describe, expect, it } from "vitest";
import { compareToBaseline, type BaselineReport } from "@/eval/baseline.ts";
import type { PackLabReport } from "@/eval/pack-lab.ts";

const caseEntry = (
  id: string,
  summary: Readonly<Record<string, number>>,
  agreed?: boolean,
): PackLabReport["cases"][number] => ({
  id,
  summary,
  agreed,
  maxSpread: 0,
  unstableAnswers: [],
  inputTokens: 10,
  outputTokens: 2,
  latencyMs: 5,
});

const report = (cases: PackLabReport["cases"]): PackLabReport => ({
  pack: "reviewer",
  model: "jev-1.12",
  repeat: 1,
  cases,
  compared: cases.filter((entry) => entry.agreed !== undefined).length,
  agreed: cases.filter((entry) => entry.agreed === true).length,
  inputTokens: 10,
  outputTokens: 2,
  meanLatencyMs: 5,
});

describe("baseline comparison", () => {
  it("flags a case the baseline met and the run now misses", () => {
    const baseline: BaselineReport = report([
      caseEntry("r1", { blockers: 1 }, true),
      caseEntry("r2", { blockers: 0 }, true),
    ]);
    const current = report([
      caseEntry("r1", { blockers: 1 }, true),
      caseEntry("r2", { blockers: 1 }, false),
    ]);

    const comparison = compareToBaseline(current, baseline);

    expect(comparison.regressions).toEqual(["r2"]);
    expect(comparison.sharedCases).toBe(2);
    expect(comparison.newCases).toEqual([]);
    expect(comparison.missingCases).toEqual([]);
    expect(comparison.drift).toEqual([{ id: "r2", key: "blockers", before: 0, after: 1 }]);
  });

  it("reports new and missing cases instead of counting them as drift", () => {
    const baseline: BaselineReport = report([
      caseEntry("r1", { blockers: 1 }, true),
      caseEntry("r2", { blockers: 0 }, true),
    ]);
    const current = report([
      caseEntry("r1", { blockers: 1 }, true),
      caseEntry("r3", { blockers: 2 }, true),
    ]);

    const comparison = compareToBaseline(current, baseline);

    expect(comparison.newCases).toEqual(["r3"]);
    expect(comparison.missingCases).toEqual(["r2"]);
    expect(comparison.drift).toEqual([]);
    expect(comparison.regressions).toEqual([]);
  });

  it("does not call an unmet baseline an improvement or regression", () => {
    const baseline: BaselineReport = report([caseEntry("r1", { blockers: 3 }, false)]);
    const current = report([caseEntry("r1", { blockers: 1 }, true)]);

    const comparison = compareToBaseline(current, baseline);

    expect(comparison.regressions).toEqual([]);
    expect(comparison.drift).toEqual([{ id: "r1", key: "blockers", before: 3, after: 1 }]);
  });
});
