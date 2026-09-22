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

  it("joins opaque call identities to checkpoints, corrections, timelines, and cohorts", () => {
    const joined: ReadonlyArray<JevEvent> = [
      {
        _tag: "call",
        ts: "2026-09-21T01:00:00.000Z",
        harness: "cli",
        sessionID: "shipped-session",
        callID: "call-1",
        purpose: "review",
        stateSizeBucket: "1k_10k",
        model: "jev-test",
        latencyMs: 40,
        status: "ok",
        questions: [{ id: "q1", type: "choice" }],
        answers: {
          q1: { _tag: "choice", choice: "yes", confidence: 0.95, probabilities: { yes: 0.95 } },
        },
        tokens: { input: 10, output: 2 },
      },
      {
        _tag: "correction",
        ts: "2026-09-21T01:00:30.000Z",
        harness: "cli",
        sessionID: "shipped-session",
        callID: "call-1",
        kind: "accepted",
        source: "operator",
      },
      {
        _tag: "checkpoint",
        ts: "2026-09-21T01:01:00.000Z",
        harness: "cli",
        sessionID: "shipped-session",
        callID: "call-1",
        kind: "test",
        result: "pass",
        source: "ci",
      },
      {
        _tag: "cohort",
        ts: "2026-09-21T01:01:01.000Z",
        harness: "cli",
        sessionID: "shipped-session",
        cohort: "assisted",
        source: "experiment",
      },
      {
        _tag: "session_label",
        ts: "2026-09-21T01:02:00.000Z",
        harness: "cli",
        sessionID: "shipped-session",
        outcome: "shipped",
        friction: 1,
        waste: "none",
        taskType: "feature",
        startedAt: "2026-09-21T01:00:00.000Z",
        endedAt: "2026-09-21T01:02:00.000Z",
        durationMs: 120_000,
        firstToolAt: "2026-09-21T01:00:30.000Z",
      },
      {
        _tag: "call",
        ts: "2026-09-21T02:00:00.000Z",
        harness: "cli",
        sessionID: "holdout-session",
        callID: "call-2",
        purpose: "verify",
        stateSizeBucket: "0_1k",
        model: "jev-test",
        latencyMs: 20,
        status: "ok",
        questions: [{ id: "q2", type: "score" }],
        answers: { q2: { _tag: "score", score: 1, confidence: 0.4 } },
      },
      {
        _tag: "checkpoint",
        ts: "2026-09-21T02:01:00.000Z",
        harness: "cli",
        sessionID: "holdout-session",
        callID: "call-2",
        kind: "test",
        result: "fail",
        source: "harness",
      },
      {
        _tag: "cohort",
        ts: "2026-09-21T02:01:01.000Z",
        harness: "cli",
        sessionID: "holdout-session",
        cohort: "holdout",
        source: "experiment",
      },
      {
        _tag: "session_label",
        ts: "2026-09-21T02:02:00.000Z",
        harness: "cli",
        sessionID: "holdout-session",
        outcome: "blocked",
        friction: 3,
        waste: "retries",
        taskType: "feature",
      },
    ];

    const report = buildImpactReport(joined, { harness: "cli" });

    expect(report.funnel).toEqual({
      calls: 2,
      identifiedCalls: 2,
      linkedInterventions: 2,
      checkpoints: 2,
      linkedCheckpoints: 2,
      unlinkedCheckpoints: 0,
      successfulCheckpoints: 1,
      linkedSessions: 2,
      shippedSessions: 1,
      reworkedSessions: 0,
      revertedSessions: 0,
      checkpointsMissingCallID: 0,
    });
    expect(report.corrections).toEqual({
      total: 1,
      linkedToCall: 1,
      sessions: 1,
      byKind: { accepted: 1 },
    });
    expect(report.calibration).toMatchObject({
      observations: 2,
      successes: 1,
      missingConfidence: 0,
      verify: {
        threshold: 0.7,
        decisions: 1,
        truePositives: 0,
        falsePositives: 0,
        trueNegatives: 1,
        falseNegatives: 0,
      },
    });
    expect(report.calibration.expectedCalibrationError).toBeCloseTo(0.15, 10);
    expect(report.calibration.buckets).toEqual([
      { bucket: "0_0.5", observations: 1, successes: 0, successRate: 0 },
      { bucket: "0.5_0.7", observations: 0, successes: 0, successRate: null },
      { bucket: "0.7_0.9", observations: 0, successes: 0, successRate: null },
      { bucket: "0.9_1", observations: 1, successes: 1, successRate: 1 },
    ]);
    expect(report.timeline).toMatchObject({
      labeledSessions: 2,
      sessionsWithDuration: 1,
      meanDurationMs: 120_000,
      sessionsWithFirstTool: 1,
      meanTimeToFirstToolMs: 30_000,
      callToCheckpointObservations: 2,
      meanCallToCheckpointMs: 60_000,
      successfulCheckpointObservations: 1,
      meanCallToSuccessfulCheckpointMs: 60_000,
      firstSuccessfulCheckpointSessions: 1,
      meanCallToFirstSuccessfulCheckpointMs: 60_000,
    });
    expect(report.overhead).toMatchObject({
      calls: 2,
      questionCount: 2,
      inputTokens: 10,
      outputTokens: 2,
      latencyMs: 60,
      meanLatencyMs: 30,
      callsMissingStateSizeBucket: 0,
      questionTypes: { choice: 1, noul: 0, score: 1 },
    });
    expect(report.cohortComparisons.map((comparison) => comparison.taskType)).toEqual(["feature"]);
    expect(report.cohortComparisons[0]?.assisted.sessions).toBe(1);
    expect(report.cohortComparisons[0]?.holdout.sessions).toBe(1);
  });

  it("falls back to a nearby prior same-session call when ids are absent", () => {
    const report = buildImpactReport([
      {
        _tag: "call",
        ts: "2026-09-21T03:00:00.000Z",
        harness: "cli",
        sessionID: "fallback-session",
        model: "jev-test",
        latencyMs: 10,
        status: "ok",
        questions: [{ id: "q1", type: "noul" }],
      },
      {
        _tag: "checkpoint",
        ts: "2026-09-21T03:05:00.000Z",
        harness: "cli",
        sessionID: "fallback-session",
        kind: "test",
        result: "pass",
        source: "harness",
      },
    ]);

    expect(report.funnel.linkedInterventions).toBe(1);
    expect(report.funnel.checkpoints).toBe(1);
    expect(report.funnel.linkedCheckpoints).toBe(1);
    expect(report.funnel.checkpointsMissingCallID).toBe(1);
    expect(report.timeline.meanCallToCheckpointMs).toBe(300_000);
  });

  it("counts one multi-answer call once in calibration", () => {
    const report = buildImpactReport([
      {
        _tag: "call",
        ts: "2026-09-21T04:00:00.000Z",
        harness: "cli",
        sessionID: "multi-answer",
        callID: "call-multi",
        purpose: "review",
        model: "jev-test",
        latencyMs: 10,
        status: "ok",
        questions: [
          { id: "q1", type: "choice" },
          { id: "q2", type: "choice" },
        ],
        answers: {
          q1: { _tag: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9 } },
          q2: { _tag: "choice", choice: "b", confidence: 0.6, probabilities: { b: 0.6 } },
        },
      },
      {
        _tag: "checkpoint",
        ts: "2026-09-21T04:01:00.000Z",
        harness: "cli",
        sessionID: "multi-answer",
        callID: "call-multi",
        kind: "test",
        result: "pass",
        source: "ci",
      },
    ]);

    // Mean confidence 0.75 lands once in 0.7_0.9; two answers must not count twice.
    expect(report.calibration.observations).toBe(1);
    expect(report.calibration.successes).toBe(1);
    expect(report.calibration.buckets[2]).toEqual({
      bucket: "0.7_0.9",
      observations: 1,
      successes: 1,
      successRate: 1,
    });
  });

  it("leaves an explicit call id unlinked when the checkpoint precedes the call", () => {
    const report = buildImpactReport([
      {
        _tag: "checkpoint",
        ts: "2026-09-21T05:00:00.000Z",
        harness: "cli",
        sessionID: "time-travel",
        callID: "call-late",
        kind: "test",
        result: "pass",
        source: "ci",
      },
      {
        _tag: "call",
        ts: "2026-09-21T05:01:00.000Z",
        harness: "cli",
        sessionID: "time-travel",
        callID: "call-late",
        purpose: "review",
        model: "jev-test",
        latencyMs: 10,
        status: "ok",
        questions: [{ id: "q1", type: "choice" }],
        answers: {
          q1: { _tag: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9 } },
        },
      },
    ]);

    expect(report.funnel.checkpoints).toBe(1);
    expect(report.funnel.linkedCheckpoints).toBe(0);
    expect(report.funnel.unlinkedCheckpoints).toBe(1);
  });

  it("does not fall back to another call when an explicit call id matches nothing", () => {
    const report = buildImpactReport([
      {
        _tag: "call",
        ts: "2026-09-21T06:00:00.000Z",
        harness: "cli",
        sessionID: "mismatch",
        callID: "call-other",
        purpose: "review",
        model: "jev-test",
        latencyMs: 10,
        status: "ok",
        questions: [{ id: "q1", type: "choice" }],
      },
      {
        _tag: "checkpoint",
        ts: "2026-09-21T06:01:00.000Z",
        harness: "cli",
        sessionID: "mismatch",
        callID: "call-missing",
        kind: "test",
        result: "pass",
        source: "ci",
      },
    ]);

    expect(report.funnel.linkedCheckpoints).toBe(0);
    expect(report.funnel.unlinkedCheckpoints).toBe(1);
  });
});
