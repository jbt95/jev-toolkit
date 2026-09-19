import { describe, expect, it } from "vitest";
import { collect, render, type MeterHealth } from "@/core/metrics.ts";
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
    errorTag: "JevApiError",
    questions: [{ id: "q3", type: "noul" }],
  },
  {
    _tag: "call",
    ts: "2026-09-17T00:02:30.000Z",
    harness: "cli",
    model: "jev-1.13.0",
    latencyMs: 40,
    status: "error",
    error: "TYPESAFE_API_KEY is not set",
    errorTag: "JevConfigError",
    questions: [{ id: "q4", type: "noul" }],
  },
  {
    _tag: "call",
    ts: "2026-09-17T00:02:45.000Z",
    harness: "cli",
    model: "jev-1.13.0",
    latencyMs: 60,
    status: "ok",
    questions: [
      { id: "q5", type: "noul" },
      { id: "q6", type: "noul" },
    ],
    answers: {
      q5: { _tag: "noul", noul: 0.99 },
      q6: { _tag: "noul", noul: 0.2 },
    },
    tokens: { input: 30, output: 3 },
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
    _tag: "opportunity",
    ts: "2026-09-17T00:05:30.000Z",
    harness: "cli",
    source: "user_prompt",
    pattern: "choice",
    matched: true,
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
    costUsd: 0.5,
    tokens: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0 },
    toolErrors: 2,
    stopReasons: { toolUse: 3, length: 1 },
  },
];

describe("metrics", () => {
  const body = render(collect(events));
  const health: MeterHealth = {
    startedAtMs: Date.parse("2026-09-17T01:00:00.000Z"),
    stats: { lines: 10, decoded: 9, skipped: 1, lastEventTs: "2026-09-17T00:07:00.000Z" },
  };

  it("counts calls and sessions per harness", () => {
    expect(body).toContain('jev_calls_total{harness="cli",status="ok"} 3');
    expect(body).toContain('jev_calls_total{harness="cli",status="error"} 2');
    expect(body).toContain('jev_sessions_with_calls_total{harness="cli"} 2');
  });

  it("counts failed calls by typed error tag", () => {
    expect(body).toContain('jev_call_errors_total{harness="cli",reason="JevApiError"} 1');
    expect(body).toContain('jev_call_errors_total{harness="cli",reason="JevConfigError"} 1');
  });

  it("counts labeled sessions that also made calls", () => {
    expect(body).toContain('jev_labeled_sessions_total{harness="cli"} 1');
    expect(body).toContain('jev_labeled_sessions_with_calls_total{harness="cli"} 1');
  });

  it("computes compliance ratios from opportunities", () => {
    expect(body).toContain('jev_compliance_ratio{harness="cli",source="assistant_message"} 0.5');
    expect(body).toContain('jev_compliance_ratio{harness="cli",source="user_prompt"} 1');
    expect(body).toContain(
      'jev_compliance_ratio{harness="claude-code",source="assistant_message"} 0',
    );
  });

  it("counts a re-detected message once and keeps the latest verdict", () => {
    const repeated: ReadonlyArray<JevEvent> = [
      ...events,
      {
        _tag: "opportunity",
        ts: "2026-09-17T00:05:00.000Z",
        harness: "cli",
        sessionID: "s9",
        source: "assistant_message",
        pattern: "percent",
        matched: false,
        messageTs: "2026-09-16T10:00:00.000Z",
      },
      {
        // A later audit of the same message: same identity, refreshed verdict.
        _tag: "opportunity",
        ts: "2026-09-17T06:00:00.000Z",
        harness: "cli",
        sessionID: "s9",
        source: "assistant_message",
        pattern: "percent",
        matched: true,
        messageTs: "2026-09-16T10:00:00.000Z",
      },
    ];

    const repeatedBody = render(collect(repeated));

    expect(repeatedBody).toContain(
      'jev_opportunities_total{harness="cli",source="assistant_message",matched="true"} 2',
    );
    expect(repeatedBody).toContain(
      'jev_opportunities_total{harness="cli",source="assistant_message",matched="false"} 1',
    );
  });

  it("sums tokens and counts triage runs", () => {
    expect(body).toContain('jev_tokens_total{harness="cli",kind="input"} 180');
    expect(body).toContain('jev_tokens_total{harness="cli",kind="output"} 18');
    expect(body).toContain('jev_triage_total{feature="failure"} 1');
  });

  it("exposes confidence and latency histograms", () => {
    expect(body).toContain('jev_confidence_bucket{primitive="choice",le="1"} 1');
    expect(body).toContain('jev_confidence_sum{primitive="choice"} 0.99');
    expect(body).toContain('jev_confidence_count{primitive="choice"} 1');
    expect(body).toContain('jev_confidence_count{primitive="score"} 1');
    expect(body).toContain('jev_latency_seconds_count{harness="cli"} 5');
    expect(body).toContain('jev_latency_seconds_bucket{harness="cli",le="+Inf"} 5');
  });

  it("exposes noul probabilities, which carry no confidence field", () => {
    expect(body).toContain('jev_noul_probability_count{harness="cli"} 2');
    expect(body).toContain('jev_noul_probability_bucket{harness="cli",le="0.3"} 1');
    expect(body).toContain('jev_noul_probability_bucket{harness="cli",le="0.99"} 2');
    expect(body).not.toContain('jev_confidence_count{primitive="noul"}');
  });

  it("aggregates session labels into outcome, waste, and friction series", () => {
    expect(body).toContain('jev_sessions_total{harness="cli",outcome="shipped"} 1');
    expect(body).toContain('jev_waste_total{harness="cli",pattern="none"} 1');
    expect(body).toContain('jev_session_friction_count{harness="cli"} 1');
    expect(body).toContain('jev_session_friction_bucket{harness="cli",le="+Inf"} 1');
  });

  it("totals digest facts carried by session labels", () => {
    expect(body).toContain('jev_session_cost_usd{harness="cli"} 0.5');
    expect(body).toContain('jev_session_tokens_total{harness="cli",kind="input"} 1000');
    expect(body).toContain('jev_session_tokens_total{harness="cli",kind="cache_read"} 5000');
    expect(body).toContain('jev_session_tool_errors_total{harness="cli"} 2');
    expect(body).toContain('jev_session_stop_reasons_total{harness="cli",reason="toolUse"} 3');
    expect(body).toContain('jev_session_stop_reasons_total{harness="cli",reason="length"} 1');
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
      "jev_reviews_total",
      "jev_review_score",
      "jev_review_direction_total",
      "jev_noul_probability",
      "jev_call_errors_total",
      "jev_session_cost_usd",
      "jev_session_tokens_total",
      "jev_session_tool_errors_total",
      "jev_session_stop_reasons_total",
      "jev_log_lines_total",
      "jev_last_event_timestamp_seconds",
      "jev_meter_start_timestamp_seconds",
    ]) {
      expect(render(collect(events, health))).toContain(`# TYPE ${name} `);
      expect(render(collect(events, health))).toContain(`# HELP ${name} `);
    }
  });

  it("reports log decode status, log freshness, and meter process age", () => {
    const bodyWithHealth = render(collect(events, health));

    expect(bodyWithHealth).toContain('jev_log_lines_total{status="decoded"} 9');
    expect(bodyWithHealth).toContain('jev_log_lines_total{status="skipped"} 1');
    expect(bodyWithHealth).toContain(
      `jev_last_event_timestamp_seconds ${Math.round(Date.parse(health.stats.lastEventTs ?? "") / 1000)}`,
    );
    expect(bodyWithHealth).toContain(
      `jev_meter_start_timestamp_seconds ${Math.round(health.startedAtMs / 1000)}`,
    );
  });

  it("omits health families when no health snapshot is supplied", () => {
    expect(body).not.toContain("jev_log_lines_total");
    expect(body).not.toContain("jev_meter_start_timestamp_seconds");
  });

  it("exposes review counts, normalized scores, and directions", () => {
    const reviewed: ReadonlyArray<JevEvent> = [
      ...events,
      {
        _tag: "review",
        ts: "2026-09-17T00:09:00.000Z",
        harness: "opencode",
        sessionID: "s3",
        model: "jev-1.13.0",
        dimensions: {
          correctness: { applicable: true, score: 0.75, confidence: 0.8, direction: "improved" },
          security: { applicable: false },
          test_quality: { applicable: true, score: 0.5, confidence: 0.7, direction: "regressed" },
        },
        topWeakness: "test_quality",
      },
    ];

    const reviewedBody = render(collect(reviewed));

    expect(reviewedBody).toContain('jev_reviews_total{harness="opencode"} 1');
    expect(reviewedBody).toContain(
      'jev_review_score{dimension="correctness",harness="opencode"} 0.75',
    );
    expect(reviewedBody).toContain(
      'jev_review_score{dimension="test_quality",harness="opencode"} 0.5',
    );
    expect(reviewedBody).not.toContain('dimension="security"');
    expect(reviewedBody).toContain(
      'jev_review_direction_total{harness="opencode",direction="improved"} 1',
    );
    expect(reviewedBody).toContain(
      'jev_review_direction_total{harness="opencode",direction="regressed"} 1',
    );
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
