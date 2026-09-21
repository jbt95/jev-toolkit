import type { Harness, JevEvent, SessionLabelEvent } from "./schema.ts";

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

export interface ImpactReport {
  readonly since: string | null;
  readonly harness: Harness | null;
  readonly coverage: ImpactCoverage;
  readonly comparisons: ReadonlyArray<ImpactComparison>;
}

export interface ImpactReportOptions {
  readonly since?: string;
  readonly harness?: Harness;
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
  const assistedSessions = new Set<string>();
  const attributedSessions = new Set<string>();
  const sessionsWithCalls = new Set<string>();
  let callEvents = 0;
  let callsWithSessionID = 0;
  let callsWithoutSessionID = 0;
  let anonymousLabeledSessions = 0;

  for (const event of events) {
    if (options.harness !== undefined && event.harness !== options.harness) continue;
    if (options.since !== undefined && event.ts < options.since) continue;
    if (event._tag === "call") {
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
  };
};
