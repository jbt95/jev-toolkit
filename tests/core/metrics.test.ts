import { describe, expect, it } from "vitest";
import { collect, render } from "@/core/metrics.ts";
import type { JevEvent } from "@/core/schema.ts";

const events: ReadonlyArray<JevEvent> = [
  {
    _tag: "call",
    ts: "2026-09-17T00:00:00.000Z",
    harness: "cli",
    sessionID: "s1",
    model: "jev-1.13.0",
    latencyMs: 50,
    status: "ok",
    questions: [{ id: "q1", type: "choice" }],
    answers: {
      q1: { _tag: "choice", choice: "a", confidence: 0.99, probabilities: { a: 0.99 } },
    },
    tokens: { input: 100, output: 10 },
  },
  {
    _tag: "call",
    ts: "2026-09-17T00:01:00.000Z",
    harness: "cli",
    sessionID: "s2",
    model: "jev-1.13.0",
    latencyMs: 120,
    status: "ok",
    questions: [{ id: "q2", type: "score" }],
    answers: { q2: { _tag: "score", score: 2, confidence: 0.8 } },
    tokens: { input: 50, output: 5 },
  },
  {
    _tag: "call",
    ts: "2026-09-17T00:02:00.000Z",
    harness: "cli",
    model: "jev-1.13.0",
    latencyMs: 30,
    status: "error",
    error: "JevApiError",
    questions: [{ id: "q3", type: "noul" }],
  },
  {
    _tag: "opportunity",
    ts: "2026-09-17T00:03:00.000Z",
    harness: "cli",
    source: "assistant_message",
    pattern: "percent",
    matched: true,
  },
  {
    _tag: "opportunity",
    ts: "2026-09-17T00:04:00.000Z",
    harness: "cli",
    source: "assistant_message",
    pattern: "ranking",
    matched: false,
  },
  {
    _tag: "opportunity",
    ts: "2026-09-17T00:05:00.000Z",
    harness: "claude-code",
    source: "assistant_message",
    pattern: "estimate",
    matched: false,
  },
  {
    _tag: "triage",
    ts: "2026-09-17T00:06:00.000Z",
    harness: "cli",
    feature: "failure",
    summary: { escalate: 0 },
  },
  {
    _tag: "session_label",
    ts: "2026-09-17T00:07:00.000Z",
    harness: "cli",
    sessionID: "s1",
    outcome: "shipped",
    friction: 2,
    waste: "none",
    taskType: "feature",
  },
];

describe("metrics", () => {
  const body = render(collect(events));

  it("counts calls and sessions per harness", () => {
    expect(body).toContain('jev_calls_total{harness="cli",status="ok"} 2');
    expect(body).toContain('jev_calls_total{harness="cli",status="error"} 1');
    expect(body).toContain('jev_sessions_with_calls_total{harness="cli"} 2');
  });

  it("counts labeled sessions that also made calls", () => {
    expect(body).toContain('jev_labeled_sessions_total{harness="cli"} 1');
    expect(body).toContain('jev_labeled_sessions_with_calls_total{harness="cli"} 1');
  });

  it("computes compliance ratios from opportunities", () => {
    expect(body).toContain('jev_compliance_ratio{harness="cli"} 0.5');
    expect(body).toContain('jev_compliance_ratio{harness="claude-code"} 0');
  });

  it("sums tokens and counts triage runs", () => {
    expect(body).toContain('jev_tokens_total{harness="cli",kind="input"} 150');
    expect(body).toContain('jev_tokens_total{harness="cli",kind="output"} 15');
    expect(body).toContain('jev_triage_total{feature="failure"} 1');
  });

  it("exposes confidence and latency histograms", () => {
    expect(body).toContain('jev_confidence_bucket{primitive="choice",le="1"} 1');
    expect(body).toContain('jev_confidence_sum{primitive="choice"} 0.99');
    expect(body).toContain('jev_confidence_count{primitive="choice"} 1');
    expect(body).toContain('jev_confidence_count{primitive="score"} 1');
    expect(body).toContain('jev_latency_seconds_count{harness="cli"} 3');
    expect(body).toContain('jev_latency_seconds_bucket{harness="cli",le="+Inf"} 3');
  });

  it("aggregates session labels into outcome, waste, and friction series", () => {
    expect(body).toContain('jev_sessions_total{harness="cli",outcome="shipped"} 1');
    expect(body).toContain('jev_waste_total{harness="cli",pattern="none"} 1');
    expect(body).toContain('jev_session_friction_count{harness="cli"} 1');
    expect(body).toContain('jev_session_friction_bucket{harness="cli",le="+Inf"} 1');
  });

  it("declares every family with HELP and TYPE", () => {
    for (const name of [
      "jev_calls_total",
      "jev_tokens_total",
      "jev_sessions_with_calls_total",
      "jev_labeled_sessions_with_calls_total",
      "jev_labeled_sessions_total",
      "jev_opportunities_total",
      "jev_compliance_ratio",
      "jev_triage_total",
      "jev_latency_seconds",
      "jev_confidence",
      "jev_sessions_total",
      "jev_waste_total",
      "jev_session_friction",
    ]) {
      expect(body).toContain(`# TYPE ${name} `);
      expect(body).toContain(`# HELP ${name} `);
    }
  });

  it("counts a re-labeled session once in the distinct labeled-session metric", () => {
    const relabeled: ReadonlyArray<JevEvent> = [
      ...events,
      {
        _tag: "session_label",
        ts: "2026-09-17T00:08:00.000Z",
        harness: "cli",
        sessionID: "s1",
        outcome: "ongoing",
        friction: 3,
        waste: "loop",
        taskType: "fix",
      },
    ];

    const relabeledBody = render(collect(relabeled));

    expect(relabeledBody).toContain('jev_labeled_sessions_total{harness="cli"} 1');
    expect(relabeledBody).toContain('jev_labeled_sessions_with_calls_total{harness="cli"} 1');
    // The latest label wins for outcome, waste, and friction.
    expect(relabeledBody).toContain('jev_sessions_total{harness="cli",outcome="ongoing"} 1');
    expect(relabeledBody).not.toContain('outcome="shipped"');
    expect(relabeledBody).toContain('jev_waste_total{harness="cli",pattern="loop"} 1');
    expect(relabeledBody).not.toContain('pattern="none"');
    expect(relabeledBody).toContain('jev_session_friction_count{harness="cli"} 1');
    expect(relabeledBody).toContain('jev_session_friction_bucket{harness="cli",le="2"} 0');
    expect(relabeledBody).toContain('jev_session_friction_bucket{harness="cli",le="3"} 1');
  });
});
