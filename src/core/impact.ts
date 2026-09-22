import type {
  CallEvent,
  CheckpointEvent,
  CohortName,
  CorrectionEvent,
  Harness,
  JevEvent,
  QuestionType,
  SessionLabelEvent,
  StateSizeBucket,
} from "./schema.ts";

type Outcome = "shipped" | "blocked" | "abandoned" | "ongoing";
type WastePattern = "none" | "loop" | "truncation" | "retries" | "waiting_on_human";

export interface ImpactStats {
  readonly sessions: number;
  readonly outcomes: Readonly<Record<Outcome, number>>;
  readonly friction: {
    readonly sessions: number;
    readonly total: number;
    readonly mean: number | null;
  };
  readonly waste: Readonly<Record<WastePattern, number>>;
  readonly cost: {
    readonly sessions: number;
    readonly totalUsd: number;
  };
  readonly toolErrors: {
    readonly sessions: number;
    readonly total: number;
  };
  readonly stopReasons: {
    readonly sessions: number;
    readonly counts: Readonly<Record<string, number>>;
  };
}

export interface ImpactComparison {
  readonly harness: Harness;
  readonly taskType: string;
  readonly assisted: ImpactStats;
  readonly unassisted: ImpactStats;
}

/** Label-side coverage: the cohort split and how many labels lack each digest fact. */
export interface LabelCoverage {
  readonly identifiedLabeledSessions: number;
  readonly assistedLabeledSessions: number;
  readonly unassistedLabeledSessions: number;
  readonly labelsMissingCost: number;
  readonly labelsMissingToolErrors: number;
  readonly labelsMissingStopReasons: number;
}

/** Whole-log coverage: call-side counts plus the label-side view. */
export interface ImpactCoverage extends LabelCoverage {
  readonly callEvents: number;
  readonly callsWithSessionID: number;
  readonly callsWithoutSessionID: number;
  readonly sessionsWithCalls: number;
  readonly attributedSessions: number;
  readonly anonymousLabeledSessions: number;
}

export interface ImpactReport extends ImpactEventReport {
  readonly since: string | null;
  readonly harness: Harness | null;
  readonly coverage: ImpactCoverage;
  readonly comparisons: ReadonlyArray<ImpactComparison>;
}

export interface ImpactReportOptions {
  readonly since?: string;
  readonly harness?: Harness;
}

export interface ImpactFunnel {
  readonly calls: number;
  readonly identifiedCalls: number;
  readonly linkedInterventions: number;
  readonly checkpoints: number;
  readonly linkedCheckpoints: number;
  readonly unlinkedCheckpoints: number;
  readonly successfulCheckpoints: number;
  readonly linkedSessions: number;
  /**
   * Linked-only outcome counts: sessions whose linked checkpoint succeeded or
   * reported rework/reversion. Label totals in `comparisons` remain the
   * denominator for unlinked work.
   */
  readonly shippedSessions: number;
  readonly reworkedSessions: number;
  readonly revertedSessions: number;
  readonly checkpointsMissingCallID: number;
}

export interface CorrectionStats {
  readonly total: number;
  readonly linkedToCall: number;
  readonly sessions: number;
  readonly byKind: Readonly<Record<string, number>>;
}

export interface CalibrationBucket {
  readonly bucket: string;
  readonly observations: number;
  readonly successes: number;
  readonly successRate: number | null;
}

export interface CalibrationReport {
  readonly observations: number;
  readonly successes: number;
  readonly missingConfidence: number;
  readonly buckets: ReadonlyArray<CalibrationBucket>;
  /**
   * Expected calibration error: mean |bucket success rate - bucket midpoint|
   * weighted by bucket share. Null when no confident observation exists.
   */
  readonly expectedCalibrationError: number | null;
  /**
   * Verify-purpose decisions at a fixed 0.7 confidence threshold: predicted
   * pass means mean confidence >= threshold, actual pass means a later
   * successful linked checkpoint. A heuristic for FP/FN counts, not a proof.
   */
  readonly verify: {
    readonly threshold: number;
    readonly decisions: number;
    readonly truePositives: number;
    readonly falsePositives: number;
    readonly trueNegatives: number;
    readonly falseNegatives: number;
  };
}

export interface TimelineReport {
  readonly labeledSessions: number;
  readonly sessionsWithDuration: number;
  readonly meanDurationMs: number | null;
  readonly sessionsWithFirstTool: number;
  readonly meanTimeToFirstToolMs: number | null;
  readonly callToCheckpointObservations: number;
  readonly meanCallToCheckpointMs: number | null;
  readonly successfulCheckpointObservations: number;
  readonly meanCallToSuccessfulCheckpointMs: number | null;
  /**
   * First successful checkpoint per linked session: how long the earliest
   * linked success took. Null means no linked session reached success.
   */
  readonly firstSuccessfulCheckpointSessions: number;
  readonly meanCallToFirstSuccessfulCheckpointMs: number | null;
}

export interface OverheadReport {
  readonly calls: number;
  readonly questionCount: number;
  readonly questionTypes: Readonly<Record<QuestionType, number>>;
  readonly stateSizeBuckets: Readonly<Record<StateSizeBucket, number>>;
  /** Legacy calls without a bucket stay visible here instead of a bucket. */
  readonly callsMissingStateSizeBucket: number;
  readonly purposes: Readonly<Record<string, number>>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly meanLatencyMs: number | null;
}

export interface CohortComparison {
  readonly harness: Harness;
  readonly taskType: string;
  readonly assisted: ImpactStats;
  readonly holdout: ImpactStats;
}

export interface ImpactEventReport {
  readonly funnel: ImpactFunnel;
  readonly corrections: CorrectionStats;
  readonly calibration: CalibrationReport;
  readonly timeline: TimelineReport;
  readonly overhead: OverheadReport;
  readonly cohortComparisons: ReadonlyArray<CohortComparison>;
}

interface MutableStats {
  sessions: number;
  outcomes: Record<Outcome, number>;
  frictionTotal: number;
  costSessions: number;
  costTotalUsd: number;
  toolErrorSessions: number;
  toolErrorTotal: number;
  stopReasonSessions: number;
  stopReasonCounts: Record<string, number>;
  waste: Record<WastePattern, number>;
}

const emptyStats = (): MutableStats => ({
  sessions: 0,
  outcomes: {
    shipped: 0,
    blocked: 0,
    abandoned: 0,
    ongoing: 0,
  },
  frictionTotal: 0,
  costSessions: 0,
  costTotalUsd: 0,
  toolErrorSessions: 0,
  toolErrorTotal: 0,
  stopReasonSessions: 0,
  stopReasonCounts: {},
  waste: {
    none: 0,
    loop: 0,
    truncation: 0,
    retries: 0,
    waiting_on_human: 0,
  },
});

const sessionKey = (harness: Harness, sessionID: string): string => `${harness}\u0000${sessionID}`;

const JOIN_WINDOW_MS = 30 * 60 * 1000;

const timestampMs = (ts: string): number | undefined => {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : undefined;
};

type DownstreamEvent = CheckpointEvent | CorrectionEvent;

interface LinkedEvent {
  readonly call: CallEvent;
  readonly event: DownstreamEvent;
  readonly sessionKey?: string;
  readonly deltaMs?: number;
}

const eventSessionKey = (event: DownstreamEvent): string | undefined =>
  event.sessionID === undefined ? undefined : sessionKey(event.harness, event.sessionID);

const linkedCallFor = (
  event: DownstreamEvent,
  calls: ReadonlyArray<CallEvent>,
): LinkedEvent | undefined => {
  if (event.callID !== undefined) {
    // Explicit identity only: a mismatched id, an unparseable timestamp, or a
    // downstream event that precedes its call stays unlinked. Falling back to
    // a different same-session call here would attribute the wrong
    // intervention, so the session/time fallback below applies solely to
    // events that carry no call id at all.
    const exact = calls.find(
      (call) => call.harness === event.harness && call.callID === event.callID,
    );
    if (exact === undefined) return undefined;
    const callMs = timestampMs(exact.ts);
    const eventMs = timestampMs(event.ts);
    if (callMs === undefined || eventMs === undefined || eventMs < callMs) return undefined;
    return {
      call: exact,
      event,
      sessionKey:
        eventSessionKey(event) ??
        (exact.sessionID === undefined ? undefined : sessionKey(exact.harness, exact.sessionID)),
      deltaMs: eventMs - callMs,
    };
  }
  const call = calls
    .filter(
      (candidate) =>
        candidate.harness === event.harness &&
        event.sessionID !== undefined &&
        candidate.sessionID === event.sessionID,
    )
    .map((candidate) => {
      const callMs = timestampMs(candidate.ts);
      const eventMs = timestampMs(event.ts);
      if (callMs === undefined || eventMs === undefined || eventMs < callMs) return undefined;
      const delta = eventMs - callMs;
      return delta <= JOIN_WINDOW_MS ? { candidate, delta } : undefined;
    })
    .filter(
      (candidate): candidate is { candidate: CallEvent; delta: number } => candidate !== undefined,
    )
    .sort((left, right) => left.delta - right.delta)[0]?.candidate;
  if (call === undefined) return undefined;
  const callMs = timestampMs(call.ts);
  const eventMs = timestampMs(event.ts);
  return {
    call,
    event,
    sessionKey:
      eventSessionKey(event) ??
      (call.sessionID === undefined ? undefined : sessionKey(call.harness, call.sessionID)),
    deltaMs:
      callMs === undefined || eventMs === undefined || eventMs < callMs
        ? undefined
        : eventMs - callMs,
  };
};

const addSessionLabel = (stats: MutableStats, label: SessionLabelEvent): void => {
  stats.sessions += 1;
  stats.outcomes[label.outcome] += 1;
  stats.frictionTotal += label.friction;
  stats.waste[label.waste] += 1;
  if (label.costUsd !== undefined) {
    stats.costSessions += 1;
    stats.costTotalUsd += label.costUsd;
  }
  if (label.toolErrors !== undefined) {
    stats.toolErrorSessions += 1;
    stats.toolErrorTotal += label.toolErrors;
  }
  if (label.stopReasons !== undefined) {
    stats.stopReasonSessions += 1;
    for (const [reason, count] of Object.entries(label.stopReasons)) {
      stats.stopReasonCounts[reason] = (stats.stopReasonCounts[reason] ?? 0) + count;
    }
  }
};

const freezeStats = (stats: MutableStats): ImpactStats => ({
  sessions: stats.sessions,
  outcomes: { ...stats.outcomes },
  friction: {
    sessions: stats.sessions,
    total: stats.frictionTotal,
    mean: stats.sessions === 0 ? null : stats.frictionTotal / stats.sessions,
  },
  waste: { ...stats.waste },
  cost: {
    sessions: stats.costSessions,
    totalUsd: stats.costTotalUsd,
  },
  toolErrors: {
    sessions: stats.toolErrorSessions,
    total: stats.toolErrorTotal,
  },
  stopReasons: {
    sessions: stats.stopReasonSessions,
    counts: { ...stats.stopReasonCounts },
  },
});

interface MutableComparison {
  readonly harness: Harness;
  readonly taskType: string;
  readonly assisted: MutableStats;
  readonly unassisted: MutableStats;
}

const comparisonKey = (harness: Harness, taskType: string): string => `${harness}\u0000${taskType}`;

/** What one filtered pass over the log yields: sessions, labels, and call counts. */
interface ImpactFacts {
  readonly labels: Map<string, SessionLabelEvent>;
  readonly cohorts: Map<string, CohortName>;
  readonly calls: ReadonlyArray<CallEvent>;
  readonly checkpoints: ReadonlyArray<CheckpointEvent>;
  readonly corrections: ReadonlyArray<CorrectionEvent>;
  readonly linkedCheckpoints: ReadonlyArray<LinkedEvent>;
  readonly linkedCorrections: ReadonlyArray<LinkedEvent>;
  readonly assistedSessions: Set<string>;
  readonly attributedSessions: Set<string>;
  readonly sessionsWithCalls: Set<string>;
  readonly callEvents: number;
  readonly callsWithSessionID: number;
  readonly callsWithoutSessionID: number;
  readonly anonymousLabeledSessions: number;
}

/** Walk the filtered log once: which sessions used Jev, and which labels exist. */
const collectImpactFacts = (
  events: ReadonlyArray<JevEvent>,
  options: ImpactReportOptions,
): ImpactFacts => {
  const labels = new Map<string, SessionLabelEvent>();
  const cohorts = new Map<string, CohortName>();
  const calls: Array<CallEvent> = [];
  const corrections: Array<CorrectionEvent> = [];
  const checkpoints: Array<CheckpointEvent> = [];
  const assistedSessions = new Set<string>();
  const attributedSessions = new Set<string>();
  const sessionsWithCalls = new Set<string>();
  let callEvents = 0;
  let callsWithSessionID = 0;
  let callsWithoutSessionID = 0;
  let anonymousLabeledSessions = 0;

  const scoped = events.filter(
    (event) =>
      (options.harness === undefined || event.harness === options.harness) &&
      (options.since === undefined || event.ts >= options.since),
  );
  for (const event of scoped) {
    if (event._tag === "call") {
      calls.push(event);
      callEvents += 1;
      if (event.sessionID === undefined) {
        callsWithoutSessionID += 1;
      } else {
        callsWithSessionID += 1;
        const key = sessionKey(event.harness, event.sessionID);
        assistedSessions.add(key);
        sessionsWithCalls.add(key);
      }
      continue;
    }
    if (event._tag === "checkpoint") {
      checkpoints.push(event);
      continue;
    }
    if (event._tag === "correction") {
      corrections.push(event);
      continue;
    }
    if (event._tag === "cohort") {
      cohorts.set(sessionKey(event.harness, event.sessionID), event.cohort);
      continue;
    }
    if (event._tag === "attribution") {
      const key = sessionKey(event.harness, event.sessionID);
      assistedSessions.add(key);
      attributedSessions.add(key);
      sessionsWithCalls.add(key);
      continue;
    }
    if (event._tag !== "session_label") continue;
    if (event.sessionID === undefined) {
      anonymousLabeledSessions += 1;
      continue;
    }
    labels.set(sessionKey(event.harness, event.sessionID), event);
  }
  return {
    labels,
    cohorts,
    calls,
    checkpoints,
    corrections,
    linkedCheckpoints: checkpoints.flatMap((event) => {
      const linked = linkedCallFor(event, calls);
      return linked === undefined ? [] : [linked];
    }),
    linkedCorrections: corrections.flatMap((event) => {
      const linked = linkedCallFor(event, calls);
      return linked === undefined ? [] : [linked];
    }),
    assistedSessions,
    attributedSessions,
    sessionsWithCalls,
    callEvents,
    callsWithSessionID,
    callsWithoutSessionID,
    anonymousLabeledSessions,
  };
};

/** One cohort per harness and task type, split by Jev assistance. */
const groupComparisons = (facts: ImpactFacts): ReadonlyArray<ImpactComparison> => {
  const comparisons = new Map<string, MutableComparison>();
  for (const [key, label] of facts.labels) {
    const groupKey = comparisonKey(label.harness, label.taskType);
    const existing = comparisons.get(groupKey);
    const comparison = existing ?? {
      harness: label.harness,
      taskType: label.taskType,
      assisted: emptyStats(),
      unassisted: emptyStats(),
    };
    addSessionLabel(
      facts.assistedSessions.has(key) ? comparison.assisted : comparison.unassisted,
      label,
    );
    if (existing === undefined) comparisons.set(groupKey, comparison);
  }
  return [...comparisons.values()]
    .sort((left, right) => {
      const harnessOrder = left.harness.localeCompare(right.harness);
      return harnessOrder === 0 ? left.taskType.localeCompare(right.taskType) : harnessOrder;
    })
    .map((comparison) => ({
      harness: comparison.harness,
      taskType: comparison.taskType,
      assisted: freezeStats(comparison.assisted),
      unassisted: freezeStats(comparison.unassisted),
    }));
};

/** Label-side coverage: the cohort split and how many labels lack each digest fact. */
const labelCoverage = (facts: ImpactFacts): LabelCoverage => {
  let assistedLabeledSessions = 0;
  let labelsMissingCost = 0;
  let labelsMissingToolErrors = 0;
  let labelsMissingStopReasons = 0;
  for (const [key, label] of facts.labels) {
    if (facts.assistedSessions.has(key)) assistedLabeledSessions += 1;
    if (label.costUsd === undefined) labelsMissingCost += 1;
    if (label.toolErrors === undefined) labelsMissingToolErrors += 1;
    if (label.stopReasons === undefined) labelsMissingStopReasons += 1;
  }
  return {
    identifiedLabeledSessions: facts.labels.size,
    assistedLabeledSessions,
    unassistedLabeledSessions: facts.labels.size - assistedLabeledSessions,
    labelsMissingCost,
    labelsMissingToolErrors,
    labelsMissingStopReasons,
  };
};

const mean = (values: ReadonlyArray<number>): number | null =>
  values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;

const checkpointSucceeded = (event: CheckpointEvent): boolean =>
  event.result === "pass" || event.result === "resolved";

/** Narrow a joined downstream event to a successful checkpoint, if it is one. */
const linkedCheckpointSucceeded = (linked: LinkedEvent): boolean =>
  linked.event._tag === "checkpoint" && checkpointSucceeded(linked.event);

const buildFunnel = (facts: ImpactFacts): ImpactFunnel => {
  const linkedCalls = new Set<CallEvent>();
  const linkedSessions = new Set<string>();
  const successfulSessions = new Set<string>();
  const reworkedSessions = new Set<string>();
  const revertedSessions = new Set<string>();
  let successfulCheckpoints = 0;
  for (const linked of facts.linkedCorrections) linkedCalls.add(linked.call);
  for (const linked of facts.linkedCheckpoints) {
    linkedCalls.add(linked.call);
    const linkedSession = linked.sessionKey;
    if (linkedSession !== undefined) {
      linkedSessions.add(linkedSession);
      if (linked.event._tag === "checkpoint" && linked.event.kind === "rework") {
        reworkedSessions.add(linkedSession);
      }
      if (linked.event._tag === "checkpoint" && linked.event.result === "reverted") {
        revertedSessions.add(linkedSession);
      }
    }
    if (linkedCheckpointSucceeded(linked)) {
      successfulCheckpoints += 1;
      if (linkedSession !== undefined) successfulSessions.add(linkedSession);
    }
  }
  const shippedSessions = [...successfulSessions].filter(
    (key) => facts.labels.get(key)?.outcome === "shipped",
  ).length;
  return {
    calls: facts.calls.length,
    identifiedCalls: facts.calls.filter((call) => call.callID !== undefined).length,
    linkedInterventions: linkedCalls.size,
    checkpoints: facts.checkpoints.length,
    linkedCheckpoints: facts.linkedCheckpoints.length,
    unlinkedCheckpoints: facts.checkpoints.length - facts.linkedCheckpoints.length,
    successfulCheckpoints,
    linkedSessions: linkedSessions.size,
    shippedSessions,
    reworkedSessions: reworkedSessions.size,
    revertedSessions: revertedSessions.size,
    checkpointsMissingCallID: facts.checkpoints.filter((event) => event.callID === undefined)
      .length,
  };
};

const buildCorrections = (facts: ImpactFacts): CorrectionStats => {
  const byKind: Record<string, number> = {};
  const sessions = new Set<string>();
  for (const event of facts.corrections) {
    byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
    const key = eventSessionKey(event);
    if (key !== undefined) sessions.add(key);
  }
  return {
    total: facts.corrections.length,
    linkedToCall: facts.linkedCorrections.length,
    sessions: sessions.size,
    byKind,
  };
};

/** Mean choice/score confidence on one call; noul answers carry none. */
const meanConfidenceOf = (call: CallEvent): number | undefined => {
  if (call.answers === undefined) return undefined;
  const values = Object.values(call.answers).flatMap((answer) =>
    answer._tag === "noul" ? [] : [answer.confidence],
  );
  if (values.length === 0) return undefined;
  return values.reduce((total, value) => total + value, 0) / values.length;
};

const calibrationBucket = (confidence: number): string => {
  if (confidence < 0.5) return "0_0.5";
  if (confidence < 0.7) return "0.5_0.7";
  if (confidence < 0.9) return "0.7_0.9";
  return "0.9_1";
};

const CALIBRATION_BUCKETS = [
  { bucket: "0_0.5", midpoint: 0.25 },
  { bucket: "0.5_0.7", midpoint: 0.6 },
  { bucket: "0.7_0.9", midpoint: 0.8 },
  { bucket: "0.9_1", midpoint: 0.95 },
] as const;
/** Fixed decision threshold for verify FP/FN counts; a reporting heuristic. */
const VERIFY_THRESHOLD = 0.7;

const buildCalibration = (facts: ImpactFacts): CalibrationReport => {
  const totals = new Map<string, { observations: number; successes: number }>();
  let observations = 0;
  let successes = 0;
  let missingConfidence = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;
  for (const linked of facts.linkedCheckpoints) {
    // One observation per linked call: a multi-answer call contributes its
    // mean confidence once, so answer count cannot inflate the denominator.
    const confidence = meanConfidenceOf(linked.call);
    if (confidence === undefined) {
      missingConfidence += 1;
      continue;
    }
    const succeeded = linkedCheckpointSucceeded(linked);
    const bucket = calibrationBucket(confidence);
    const entry = totals.get(bucket) ?? { observations: 0, successes: 0 };
    entry.observations += 1;
    if (succeeded) {
      entry.successes += 1;
      successes += 1;
    }
    observations += 1;
    totals.set(bucket, entry);
    if (linked.call.purpose === "verify") {
      const predicted = confidence >= VERIFY_THRESHOLD;
      if (predicted && succeeded) truePositives += 1;
      else if (predicted) falsePositives += 1;
      else if (succeeded) falseNegatives += 1;
      else trueNegatives += 1;
    }
  }
  const buckets = CALIBRATION_BUCKETS.map(({ bucket, midpoint }) => {
    const entry = totals.get(bucket) ?? { observations: 0, successes: 0 };
    return {
      bucket,
      observations: entry.observations,
      successes: entry.successes,
      successRate: entry.observations === 0 ? null : entry.successes / entry.observations,
      midpoint,
    };
  });
  const expectedCalibrationError =
    observations === 0
      ? null
      : buckets.reduce(
          (total, bucket) =>
            bucket.successRate === null
              ? total
              : total +
                Math.abs(bucket.successRate - bucket.midpoint) *
                  (bucket.observations / observations),
          0,
        );
  const verifyDecisions = truePositives + falsePositives + trueNegatives + falseNegatives;
  return {
    observations,
    successes,
    missingConfidence,
    buckets: buckets.map(({ bucket, observations, successes, successRate }) => ({
      bucket,
      observations,
      successes,
      successRate,
    })),
    expectedCalibrationError,
    verify: {
      threshold: VERIFY_THRESHOLD,
      decisions: verifyDecisions,
      truePositives,
      falsePositives,
      trueNegatives,
      falseNegatives,
    },
  };
};

const buildTimeline = (facts: ImpactFacts): TimelineReport => {
  const durations: Array<number> = [];
  const firstToolDelays: Array<number> = [];
  for (const label of facts.labels.values()) {
    if (label.durationMs !== undefined && label.durationMs >= 0) durations.push(label.durationMs);
    if (label.startedAt !== undefined && label.firstToolAt !== undefined) {
      const started = timestampMs(label.startedAt);
      const firstTool = timestampMs(label.firstToolAt);
      if (started !== undefined && firstTool !== undefined && firstTool >= started) {
        firstToolDelays.push(firstTool - started);
      }
    }
  }
  const callToCheckpoint = facts.linkedCheckpoints.flatMap((linked) =>
    linked.deltaMs === undefined ? [] : [linked.deltaMs],
  );
  const successfulCallToCheckpoint = facts.linkedCheckpoints.flatMap((linked) =>
    linked.deltaMs !== undefined && linkedCheckpointSucceeded(linked) ? [linked.deltaMs] : [],
  );
  // Earliest linked success per session: the "time to first success" behind
  // the mean over all linked successes above.
  const firstSuccessfulBySession = new Map<string, number>();
  for (const linked of facts.linkedCheckpoints) {
    if (
      linked.deltaMs === undefined ||
      linked.sessionKey === undefined ||
      !linkedCheckpointSucceeded(linked)
    ) {
      continue;
    }
    const seen = firstSuccessfulBySession.get(linked.sessionKey);
    if (seen === undefined || linked.deltaMs < seen) {
      firstSuccessfulBySession.set(linked.sessionKey, linked.deltaMs);
    }
  }
  const firstSuccessfulDelays = [...firstSuccessfulBySession.values()];
  return {
    labeledSessions: facts.labels.size,
    sessionsWithDuration: durations.length,
    meanDurationMs: mean(durations),
    sessionsWithFirstTool: firstToolDelays.length,
    meanTimeToFirstToolMs: mean(firstToolDelays),
    callToCheckpointObservations: callToCheckpoint.length,
    meanCallToCheckpointMs: mean(callToCheckpoint),
    successfulCheckpointObservations: successfulCallToCheckpoint.length,
    meanCallToSuccessfulCheckpointMs: mean(successfulCallToCheckpoint),
    firstSuccessfulCheckpointSessions: firstSuccessfulDelays.length,
    meanCallToFirstSuccessfulCheckpointMs: mean(firstSuccessfulDelays),
  };
};

const buildOverhead = (facts: ImpactFacts): OverheadReport => {
  const questionTypes: Record<QuestionType, number> = { choice: 0, noul: 0, score: 0 };
  const stateSizeBuckets: Record<StateSizeBucket, number> = {
    "0_1k": 0,
    "1k_10k": 0,
    "10k_50k": 0,
    "50k_plus": 0,
  };
  const purposes: Record<string, number> = {};
  let questionCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let latencyMs = 0;
  let callsMissingStateSizeBucket = 0;
  for (const call of facts.calls) {
    questionCount += call.questions.length;
    for (const question of call.questions) questionTypes[question.type] += 1;
    if (call.stateSizeBucket === undefined) callsMissingStateSizeBucket += 1;
    else stateSizeBuckets[call.stateSizeBucket] += 1;
    const purpose = call.purpose ?? "unknown";
    purposes[purpose] = (purposes[purpose] ?? 0) + 1;
    latencyMs += call.latencyMs;
    if (call.tokens !== undefined) {
      inputTokens += call.tokens.input;
      outputTokens += call.tokens.output;
    }
  }
  return {
    calls: facts.calls.length,
    questionCount,
    questionTypes,
    stateSizeBuckets,
    callsMissingStateSizeBucket,
    purposes,
    inputTokens,
    outputTokens,
    latencyMs,
    meanLatencyMs: facts.calls.length === 0 ? null : latencyMs / facts.calls.length,
  };
};

const groupCohortComparisons = (facts: ImpactFacts): ReadonlyArray<CohortComparison> => {
  const comparisons = new Map<string, MutableComparison>();
  for (const [key, label] of facts.labels) {
    const cohort = facts.cohorts.get(key);
    if (cohort === undefined) continue;
    const groupKey = comparisonKey(label.harness, label.taskType);
    const existing = comparisons.get(groupKey);
    const comparison = existing ?? {
      harness: label.harness,
      taskType: label.taskType,
      assisted: emptyStats(),
      unassisted: emptyStats(),
    };
    addSessionLabel(cohort === "assisted" ? comparison.assisted : comparison.unassisted, label);
    if (existing === undefined) comparisons.set(groupKey, comparison);
  }
  return [...comparisons.values()]
    .sort((left, right) => {
      const harnessOrder = left.harness.localeCompare(right.harness);
      return harnessOrder === 0 ? left.taskType.localeCompare(right.taskType) : harnessOrder;
    })
    .map((comparison) => ({
      harness: comparison.harness,
      taskType: comparison.taskType,
      assisted: freezeStats(comparison.assisted),
      holdout: freezeStats(comparison.unassisted),
    }));
};

/**
 * Build an observational comparison from the privacy-preserving event stream.
 * A session is assisted when a call or recovered attribution identifies it.
 * Anonymous labels remain visible in coverage but cannot join either cohort.
 */
export const buildImpactReport = (
  events: ReadonlyArray<JevEvent>,
  options: ImpactReportOptions = {},
): ImpactReport => {
  const facts = collectImpactFacts(events, options);
  return {
    since: options.since ?? null,
    harness: options.harness ?? null,
    coverage: {
      callEvents: facts.callEvents,
      callsWithSessionID: facts.callsWithSessionID,
      callsWithoutSessionID: facts.callsWithoutSessionID,
      sessionsWithCalls: facts.sessionsWithCalls.size,
      attributedSessions: facts.attributedSessions.size,
      anonymousLabeledSessions: facts.anonymousLabeledSessions,
      ...labelCoverage(facts),
    },
    comparisons: groupComparisons(facts),
    funnel: buildFunnel(facts),
    corrections: buildCorrections(facts),
    calibration: buildCalibration(facts),
    timeline: buildTimeline(facts),
    overhead: buildOverhead(facts),
    cohortComparisons: groupCohortComparisons(facts),
  };
};
