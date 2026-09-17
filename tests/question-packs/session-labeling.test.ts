import { describe, expect, it } from "vitest";
import type { SessionDigest } from "@/audit/sessions.ts";
import { labelQuestions } from "@/question-packs/session-labeling.ts";

const digest = (sessionID: string): SessionDigest => ({
  harness: "cli",
  sessionID,
  startedAt: "2026-09-17T00:00:00.000Z",
  userPrompts: ["fix the parser"],
  assistantTurns: 2,
  toolCounts: { shell: 1 },
  errorCount: 0,
});

describe("session labeling questions", () => {
  it("asks an indexed task type per session instead of one batch-wide answer", () => {
    const questions = labelQuestions([digest("a"), digest("b")]);

    expect(Object.keys(questions).sort()).toEqual([
      "s0_friction",
      "s0_outcome",
      "s0_task_type",
      "s0_waste",
      "s1_friction",
      "s1_outcome",
      "s1_task_type",
      "s1_waste",
    ]);
    expect(questions["task_type"]).toBeUndefined();
  });
});
