import { describe, expect, it } from "vitest";
import { buildImpactReport } from "@/core/impact.ts";
import type { JevEvent } from "@/core/schema.ts";

const events: ReadonlyArray<JevEvent> = [
  {
    _tag: "call",
    ts: "2026-09-21T00:00:00.000Z",
    harness: "opencode",
    sessionID: "assisted-feature",
    model: "jev-test",
    latencyMs: 10,
    status: "ok",
    questions: [{ id: "q1", type: "choice" }],
  },
  {
    _tag: "call",
    ts: "2026-09-21T00:01:00.000Z",
    harness: "opencode",
    model: "jev-test",
    latencyMs: 10,
    status: "ok",
    questions: [{ id: "q2", type: "choice" }],
  },
  {
    _tag: "attribution",
    ts: "2026-09-21T00:02:00.000Z",
    harness: "pi",
    sessionID: "attributed-fix",
  },
  {
    _tag: "session_label",
    ts: "2026-09-21T00:03:00.000Z",
    harness: "opencode",
    sessionID: "assisted-feature",
    outcome: "shipped",
    friction: 1,
    waste: "none",
    taskType: "feature",
    costUsd: 0.5,
    toolErrors: 1,
    stopReasons: { stop: 1 },
  },
  {
    _tag: "session_label",
    ts: "2026-09-21T00:04:00.000Z",
    harness: "opencode",
    sessionID: "assisted-feature",
    outcome: "blocked",
    friction: 3,
    waste: "loop",
    taskType: "feature",
  },
  {
    _tag: "session_label",
    ts: "2026-09-21T00:05:00.000Z",
    harness: "opencode",
    sessionID: "unassisted-fix",
    outcome: "blocked",
    friction: 4,
    waste: "retries",
    taskType: "fix",
    costUsd: 1.25,
    toolErrors: 2,
    stopReasons: { length: 1 },
  },
  {
    _tag: "session_label",
    ts: "2026-09-21T00:06:00.000Z",
    harness: "pi",
    sessionID: "attributed-fix",
    outcome: "ongoing",
    friction: 2,
    waste: "waiting_on_human",
    taskType: "fix",
  },
  {
    _tag: "session_label",
    ts: "2026-09-21T00:07:00.000Z",
    harness: "pi",
    outcome: "ongoing",
    friction: 2,
    waste: "none",
    taskType: "analysis",
  },
];

/** A cohort with no sessions: the shape every empty side of a comparison has. */
const noSessions = {
  sessions: 0,
  outcomes: { shipped: 0, blocked: 0, abandoned: 0, ongoing: 0 },
  friction: { sessions: 0, total: 0, mean: null },
  waste: { none: 0, loop: 0, truncation: 0, retries: 0, waiting_on_human: 0 },
  cost: { sessions: 0, totalUsd: 0 },
  toolErrors: { sessions: 0, total: 0 },
  stopReasons: { sessions: 0, counts: {} },
};

describe("impact report", () => {
  it("compares latest labeled sessions by Jev assistance and task type", () => {
    const report = buildImpactReport(events, {
      since: "2026-09-21T00:00:00.000Z",
      harness: "opencode",
    });

    expect(report.coverage).toEqual({
      callEvents: 2,
      callsWithSessionID: 1,
      callsWithoutSessionID: 1,
      sessionsWithCalls: 1,
      attributedSessions: 0,
      identifiedLabeledSessions: 2,
      anonymousLabeledSessions: 0,
      assistedLabeledSessions: 1,
      unassistedLabeledSessions: 1,
      labelsMissingCost: 1,
      labelsMissingToolErrors: 1,
      labelsMissingStopReasons: 1,
    });

    expect(report.comparisons).toEqual([
      {
        harness: "opencode",
        taskType: "feature",
        assisted: {
          sessions: 1,
          outcomes: { shipped: 0, blocked: 1, abandoned: 0, ongoing: 0 },
          friction: { sessions: 1, total: 3, mean: 3 },
          waste: { none: 0, loop: 1, truncation: 0, retries: 0, waiting_on_human: 0 },
          cost: { sessions: 0, totalUsd: 0 },
          toolErrors: { sessions: 0, total: 0 },
          stopReasons: { sessions: 0, counts: {} },
        },
        unassisted: noSessions,
      },
      {
        harness: "opencode",
        taskType: "fix",
        assisted: noSessions,
        unassisted: {
          sessions: 1,
          outcomes: { shipped: 0, blocked: 1, abandoned: 0, ongoing: 0 },
          friction: { sessions: 1, total: 4, mean: 4 },
          waste: { none: 0, loop: 0, truncation: 0, retries: 1, waiting_on_human: 0 },
          cost: { sessions: 1, totalUsd: 1.25 },
          toolErrors: { sessions: 1, total: 2 },
          stopReasons: { sessions: 1, counts: { length: 1 } },
        },
      },
    ]);
  });
});
