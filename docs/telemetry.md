# Telemetry roadmap

The current event log measures Jev usage and session-level conditions. It does
not yet measure the complete impact chain:

```text
Jev judgment -> agent action -> objective checkpoint -> session outcome
```

This page documents the smallest useful next step for the blog's impact story,
follow-up features, and the boundaries that keep the measurements honest.

## What exists today

The current telemetry already records:

- Jev call status, latency, model, question ids and types, answers, confidence,
  probabilities, and TypeSafe token usage;
- sessions touched by Jev, including offline attribution recovered from
  harness transcripts;
- detected quantitative claims and whether they aligned with Jev usage;
- session outcome, friction, waste pattern, task type, cost, tokens, tool
  errors, and stop reasons;
- review scores, review directions, triage summaries, and skill routes;
- explicit objective checkpoints recorded by `jev checkpoint`; and
- stable opaque call ids plus closed semantic purposes on new Jev call events;
- an observational assisted-versus-unassisted comparison by harness and task
  type;
- joined call, correction, checkpoint, cohort, calibration, timeline, and
  overhead reporting from `jev impact`; and
- privacy-safe state-size buckets, call purposes, question primitives, and
  session timing facts.

See [`src/core/schema.ts`](../src/core/schema.ts),
[`docs/metrics.md`](metrics.md), and [`src/core/impact.ts`](../src/core/impact.ts).

The missing evidence is not another usage counter. It is the link between a
specific Jev intervention and what the agent did next.

## Highest-impact first slice (implemented)

### 1. Add objective outcome checkpoints

Record bounded downstream results without putting raw code, diffs, transcripts,
or command output in the event log. Examples include:

- tests, lint, or builds passed or failed;
- a review finding was resolved;
- a commit was created;
- a change was reverted; and
- later rework was required.

The implemented event shape is intentionally small:

```ts
{
   _tag: "checkpoint",
   ts,
   harness,
   sessionID,
   callID,
  kind: "test" | "lint" | "build" | "review" | "commit" | "rework",
  result: "pass" | "fail" | "resolved" | "reverted",
  source: "harness" | "ci" | "git" | "operator"
}
```

`kind`, `result`, and `source` should remain closed, low-cardinality enums.
Checkpoint producers should emit summaries and counts only. The raw evidence can
stay local to the harness, CI system, or operator.

This enables metrics such as:

- `jev_checkpoints_total{kind,result,harness}`;
- checkpoint success ratio;
- time from intervention to first successful checkpoint; and
- rework or revert rate after an intervention.

Start with offline importers or existing harness/CI records. Do not add a new
agent prompt merely to ask whether the work succeeded when the session already
contains an observable test, build, review, or git result.

### 2. Give interventions stable, semantic identities (implemented)

New `call` events carry an opaque local `callID` and a closed `purpose`, for
example `review`, `verify`, `route`, `triage`, or `claim_detection`. The id is
generated once per ask and shared by the fetch and SDK logging paths. Existing
events without these fields remain readable.

The call identity is intentionally small:

```ts
{
  _tag: "call",
  callID,
  purpose: "ask" | "claim_detection" | "claim_alignment" |
    "session_label" | "commit_check" | "review" | "verify" |
    "route" | "triage" | "eval"
}
```

The checkpoint can then refer to `callID` without copying question
text, state, answers, or code. Where a harness cannot forward an id, retain the
existing offline attribution and use session plus time-window correlation as a
fallback.

Do not expose `callID` or `sessionID` as Prometheus labels. They are high
cardinality and belong in the local event log or an offline report.

### 3. Add one impact report over the joined events (implemented)

Extend `jev impact` only after the event join is available. The useful report is
not a larger list of counters; it is a compact funnel:

```text
Jev calls
  -> linked interventions
    -> objective checkpoints
      -> successful checkpoints
        -> shipped / reworked / reverted sessions
```

Keep the existing assisted-versus-unassisted comparison, but label it
observational until a controlled assignment or stronger matching design exists.

`jev impact --json` now includes the funnel plus the following offline-only
sections:

- `funnel`: calls, identified and linked interventions, total/linked/unlinked
  checkpoints, and shipped/reworked/reverted session counts (funnel outcome
  counts are linked-only; label totals in `comparisons` are the denominator
  for unlinked work);
- `corrections`: accepted/rejected, overrides, clarifications, handoffs, and
  escalation counts, including call-link coverage;
- `calibration`: per-call mean confidence buckets compared with successful
  linked checkpoints, expected calibration error, verify-purpose FP/FN counts
  at a 0.7 threshold, and missing-confidence denominators;
- `timeline`: session duration, time to first tool, call-to-checkpoint means,
  and mean time to the first linked success per session; and
- `overhead`: question primitive counts, state-size buckets (with an explicit
  missing-bucket count for legacy calls), purposes, tokens, and latency.

An explicit `callID` is the preferred join and never falls back: a mismatched
id or a checkpoint timestamped before its call stays unlinked. Only events
without a call id use the nearest prior same-session call within 30 minutes.
Unmatched and missing-id observations remain visible in the report rather than
being silently attributed.

## High-impact feature set

These are now represented in the offline report and event log. The
prioritization signal below came from Jev and is guidance rather than a truth
claim.

| Feature | Why it matters | Jev evidence-value score |
|---|---|---:|
| Objective outcomes | Connects Jev use to tests, reviews, commits, rework, and reversions | 2.83/3, confidence 0.83 |
| Cohort design | Makes assisted-versus-unassisted comparisons less confounded | 2.79/3, confidence 0.79 |
| Correction and escalation events | Shows when developers accept, override, or repair an agent decision | 2.46/3, confidence 0.49 |
| Intervention ledger | Shows whether the agent followed a Jev result and what action followed | 2.42/3, confidence 0.51 |
| Session timeline | Shows time-to-action, retries, loops, and time-to-success | 1.91/3, confidence 0.67 |
| Context efficiency | Measures judgment overhead by question count, state-size bucket, tokens, and latency | 1.88/3, confidence 0.63 |

### Calibration against realized outcomes (implemented)

`jev impact --json` compares per-call mean confidence buckets on linked calls
with later checkpoint results and includes missing-confidence denominators.
A multi-answer call contributes once (its mean), so answer count cannot
inflate the denominator. The report also includes expected calibration error
and verify-purpose false-positive/false-negative counts at a fixed 0.7
confidence threshold (a reporting heuristic, documented in the output).

Possible outputs:

- confidence bucket versus successful checkpoint rate;
- false-positive and false-negative counts for verification questions; and
- calibration error over time or by question purpose.

This supports a more precise claim than “Jev is confident”: it tests whether
confidence helps the agent decide when to act and when to seek more evidence.

### Correction and escalation telemetry (implemented)

`jev correction` records only observable event types:

- developer correction;
- manual override;
- clarification request;
- human handoff;
- escalation; and
- accepted or rejected recommendation.

The event carries only a closed kind, source, optional session, and optional
call id. Raw transcript text never enters the log.

### Session timeline and effort (implemented)

`SessionDigest` aggregates turns, tools, errors, tokens, cost, stop reasons, and
bounded timing facts used to answer “what changed after Jev?” The report derives:

- session duration and end time;
- time to first tool action;
- time from Jev call to linked checkpoints (the observable next actions);
- retries proxied by waste patterns, tool errors, and stop reasons already in
  the label totals; and
- time to the first linked successful checkpoint per session.

Per-turn retries split before and after the intervention need turn-level
timestamps the digest does not retain; that split remains future work.

The label producer carries bounded timing facts and `jev impact` reports
offline means. Per-session ids remain absent from Prometheus labels.

### Controlled holdouts and better cohorts (implemented)

`jev cohort` adds an opt-in assignment event with the closed vocabulary
`assisted` and `holdout`; `jev impact` reports those assignments separately from
the observational call-derived split. Both groups should still emit the same
objective checkpoints.

For non-experimental comparisons, stratify by privacy-safe buckets. Implemented
today: harness and task type. Deferred until digests carry the facts:
agent/model version, changed-file count bucket, prior failure count bucket,
and session complexity bucket.

Do not describe the result as causal unless assignment or the analysis design
supports that claim.

### Context and overhead efficiency (implemented)

Measure the cost of the judgment itself without retaining its contents:

- question count and primitive mix;
- state-size bucket;
- Jev input/output tokens;
- Jev latency; and
- session tokens or duration associated with the intervention.

The report keeps overhead beside checkpoint and rework outcomes. Prometheus
adds only low-cardinality purpose, primitive, and state-size bucket series.

## Blog-ready visualizations

Each visual names its source. Offline (`jev impact --json`) visuals:

1. **An intervention funnel** from Jev call to linked action to successful
   checkpoint to shipped session (linked-only counts; label totals supply the
   unlinked denominator).
2. **A calibration plot** comparing per-call mean confidence buckets with
   observed outcomes, plus expected calibration error.
3. **A session timeline** showing the Jev call, next linked checkpoint, and
   first passing test.
4. **A cost/latency versus outcome view** showing overhead beside time to
   success and rework rate.

Dashboard (Prometheus) visuals:

5. **Assisted versus unassisted grouped bars** for successful checkpoints,
   rework, and reverts, with sample sizes shown.
6. **Calls by purpose and state-size bucket**, corrections by kind, checkpoint
   link coverage, and cohort assignments — the low-cardinality context panels.

The existing calls, tokens, compliance, and confidence panels remain useful as
adoption and system-health context. They should not be presented as proof of
better work on their own.

## Measurement and privacy rules

- Preserve the current local-only event-log boundary.
- Log enums, counts, durations, masked values, and opaque ids only.
- Never put raw code, diffs, transcripts, credentials, or command output in
  events or Prometheus labels.
- Prefer deriving checkpoints from existing harness, CI, and git records before
  adding new agent-facing tools.
- Show denominators and missing-data coverage beside every outcome metric.
- Keep assisted-versus-unassisted results explicitly observational until the
  study design justifies a causal statement.

## Suggested implementation order

1. Checkpoint event, CLI producer, and checkpoint metrics (implemented).
2. `callID` plus closed `purpose` on call events (implemented).
3. A joined `jev impact` funnel (implemented).
4. Offline timeline and correction/escalation reporting (implemented).
5. Calibration reporting and optional holdout/cohort metadata (implemented).
