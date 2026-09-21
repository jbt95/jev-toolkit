import { describe, expect, it } from "vitest";
import {
  NO_SKILL,
  skillRoute,
  skillRouteQuestions,
  type SkillRouteInput,
} from "@/question-packs/skill-routing.ts";
import type { AnswerMap } from "@/core/schema.ts";

const input: SkillRouteInput = {
  task: "the export button spins forever; find out why and fix it",
  candidates: [
    { name: "debugging", description: "Systematic root-cause debugging for failures and errors." },
    { name: "better-ui", description: "UI polish: radius, spacing, hit areas, depth." },
    { name: "postgresql-performance", description: "Postgres query shape, indexes, plans." },
  ],
};

const answers = (overrides: AnswerMap): AnswerMap => ({
  skill: { _tag: "choice", choice: "debugging", confidence: 0.99, probabilities: {} },
  second: { _tag: "noul", noul: 0.58 },
  dependence: { _tag: "score", score: 2.1, confidence: 0.5 },
  ...overrides,
});

describe("skillRouteQuestions", () => {
  it("offers every candidate plus a no-skill option, and repeats the task", () => {
    const questions = skillRouteQuestions(input);
    const skill = questions["skill"];
    if (skill?._tag !== "choice") throw new Error("expected a choice question");

    expect(Object.keys(skill.criteria ?? {})).toEqual([
      "debugging",
      "better-ui",
      "postgresql-performance",
      NO_SKILL,
    ]);
    expect(skill.instructions).toContain("export button spins forever");
    expect(questions["second"]?._tag).toBe("noul");
    expect(questions["dependence"]?._tag).toBe("score");
  });

  it("keeps criterion text on one line", () => {
    const questions = skillRouteQuestions({
      task: "t",
      candidates: [{ name: "skill", description: "  first line\nsecond line  " }],
    });
    const skill = questions["skill"];
    if (skill?._tag !== "choice") throw new Error("expected a choice question");
    expect(skill.criteria?.["skill"]).toBe("first line second line");
  });
});

describe("skillRoute", () => {
  it("routes a confident, depended-on pick", () => {
    expect(skillRoute(input, answers({}))).toEqual({
      _tag: "routed",
      skill: "debugging",
      confidence: 0.99,
      dependence: 2.1,
      secondNeeded: true,
    });
  });

  it("does not route when the model answers none", () => {
    const route = skillRoute(
      input,
      answers({ skill: { _tag: "choice", choice: NO_SKILL, confidence: 0.9, probabilities: {} } }),
    );
    expect(route).toMatchObject({ _tag: "none", reason: "no-match" });
  });

  it("rejects a pick outside the catalog", () => {
    const route = skillRoute(
      input,
      answers({
        skill: { _tag: "choice", choice: "invented", confidence: 0.9, probabilities: {} },
      }),
    );
    expect(route).toMatchObject({ _tag: "none", reason: "unknown-skill" });
  });

  it("refuses a pick below the confidence or dependence floor", () => {
    expect(
      skillRoute(
        input,
        answers({
          skill: { _tag: "choice", choice: "debugging", confidence: 0.41, probabilities: {} },
        }),
      ),
    ).toMatchObject({ _tag: "none", reason: "low-confidence" });
    expect(
      skillRoute(input, answers({ dependence: { _tag: "score", score: 0.68, confidence: 0.4 } })),
    ).toMatchObject({ _tag: "none", reason: "low-dependence" });
  });

  it("takes floors from the caller", () => {
    const route = skillRoute(
      input,
      answers({
        skill: { _tag: "choice", choice: "debugging", confidence: 0.41, probabilities: {} },
      }),
      { confidence: 0.2, dependence: 0 },
    );
    expect(route).toMatchObject({ _tag: "routed", skill: "debugging" });
  });

  it("reports no-match when the answer is missing or not a choice", () => {
    expect(skillRoute(input, {})).toMatchObject({
      _tag: "none",
      reason: "no-match",
      confidence: 0,
    });
    expect(skillRoute(input, { skill: { _tag: "noul", noul: 0.9 } })).toMatchObject({
      _tag: "none",
      reason: "no-match",
    });
  });
});
