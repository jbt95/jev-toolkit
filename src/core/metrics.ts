import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createServer, type ServerResponse } from "node:http";
import type { EventLogService, EventLogStats } from "./events.ts";
import type {
  AttributionEvent,
  RouteEvent,
  CallEvent,
  JevEvent,
  OpportunityEvent,
  ReviewEvent,
  SessionLabelEvent,
} from "./schema.ts";

export class MeterError extends Data.TaggedError("MeterError")<{}> {}

export interface MetricFamily {
  readonly name: string;
  readonly help: string;
  readonly type: "counter" | "gauge" | "histogram";
  readonly lines: ReadonlyArray<string>;
}

export interface MetricsSnapshot {
  readonly families: ReadonlyArray<MetricFamily>;
}

/**
 * Process and log facts of one scrape. Without them the meter cannot say how
 * old it is or whether the log it reads still parses, which is how a stale
 * process and a silent schema break both stayed invisible.
 */
export interface MeterHealth {
  /** Unix milliseconds when the meter process started. */
  readonly startedAtMs: number;
  readonly stats: EventLogStats;
}

const CONFIDENCE_BUCKETS = [0.5, 0.7, 0.8, 0.9, 0.95, 0.99, 1] as const;
const NOUL_BUCKETS = [0.1, 0.3, 0.5, 0.7, 0.9, 0.99] as const;
const LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10] as const;
const FRICTION_BUCKETS = [1, 2, 3, 4, 5] as const;

type LabelPairs = ReadonlyArray<readonly [string, string]>;

const labelString = (pairs: LabelPairs): string =>
  pairs.length === 0 ? "" : `{${pairs.map(([key, value]) => `${key}="${value}"`).join(",")}}`;

const sample = (name: string, pairs: LabelPairs, value: number): string =>
  `${name}${labelString(pairs)} ${value}`;

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

interface Histogram {
  readonly buckets: Array<number>;
  sum: number;
  count: number;
}

const newHistogram = (thresholds: readonly number[]): Histogram => ({
  buckets: thresholds.map(() => 0),
  sum: 0,
  count: 0,
});

const observe = (histogram: Histogram, thresholds: readonly number[], value: number): void => {
  thresholds.forEach((le, index) => {
    if (value <= le) histogram.buckets[index] += 1;
  });
  histogram.sum += value;
  histogram.count += 1;
};

const histogramLines = (
  name: string,
  labelName: string,
  pairs: LabelPairs,
  thresholds: readonly number[],
  histogram: Histogram,
): ReadonlyArray<string> => {
  const bucketLines = thresholds.map((le, index) =>
    sample(`${name}_bucket`, [...pairs, [labelName, String(le)]], histogram.buckets[index] ?? 0),
  );
  return [
    ...bucketLines,
    sample(`${name}_bucket`, [...pairs, [labelName, "+Inf"]], histogram.count),
    sample(`${name}_sum`, pairs, round(histogram.sum)),
    sample(`${name}_count`, pairs, histogram.count),
  ];
};

const sorted = <T>(map: ReadonlyMap<string, T>): ReadonlyArray<readonly [string, T]> =>
  [...map.entries()].sort(([a], [b]) => a.localeCompare(b));

/** One counter family with a by-harness line per map entry. */
const harnessCounter = <A>(
  name: string,
  help: string,
  entries: ReadonlyMap<string, A>,
  value: (entry: A, harness: string) => number,
): MetricFamily => ({
  name,
  help,
  type: "counter",
  lines: sorted(entries).map(([harness, entry]) =>
    sample(name, [["harness", harness]], value(entry, harness)),
  ),
});

/**
 * A counter or gauge family over a `label|label` keyed map: the key splits into
 * label values in order and the map value becomes the sample. Families that
 * emit more than one line per key (calls, tokens, opportunities) stay explicit.
 */
const keyedFamily = (
  name: string,
  help: string,
  type: "counter" | "gauge",
  labels: ReadonlyArray<string>,
  values: ReadonlyMap<string, number>,
  scale?: (value: number) => number,
): MetricFamily => ({
  name,
  help,
  type,
  lines: sorted(values).map(([key, value]) => {
    const parts = key.split("|");
    return sample(
      name,
      labels.map((label, index) => [label, parts[index] ?? ""] as const),
      scale === undefined ? value : scale(value),
    );
  }),
});

/** Composite metric keys are `primary|secondary`; split them back into labels. */
const splitKey = (key: string): readonly [string, string] => {
  const separator = key.indexOf("|");
  return separator < 0 ? [key, ""] : [key.slice(0, separator), key.slice(separator + 1)];
};

/** One accumulator per event kind; collect() only dispatches and finalizes. */
interface EventAccumulator {
  readonly calls: Map<string, { ok: number; error: number }>;
  readonly callErrors: Map<string, number>;
  readonly skillRoutes: Map<string, number>;
  readonly tokens: Map<string, { input: number; output: number }>;
  readonly opportunities: Map<string, { matched: number; missed: number }>;
  readonly detectedOpportunities: Map<string, OpportunityEvent>;
  readonly sessions: Map<string, Set<string>>;
  readonly labeledSessions: Map<string, Set<string>>;
  readonly triage: Map<string, number>;
  readonly latency: Map<string, Histogram>;
  readonly confidence: Map<string, Histogram>;
  readonly noulProbability: Map<string, Histogram>;
  readonly sessionOutcomes: Map<string, number>;
  readonly sessionWaste: Map<string, number>;
  readonly sessionFriction: Map<string, Histogram>;
  readonly sessionCost: Map<string, number>;
  readonly sessionTokens: Map<string, number>;
  readonly sessionToolErrors: Map<string, number>;
  readonly sessionStopReasons: Map<string, number>;
  readonly reviews: Map<string, number>;
  readonly reviewScores: Map<string, { sum: number; count: number }>;
  readonly reviewDirections: Map<string, number>;
  readonly latestLabel: Map<string, SessionLabelEvent>;
  readonly anonymousLabels: Array<SessionLabelEvent>;
}

const newAccumulator = (): EventAccumulator => ({
  calls: new Map(),
  callErrors: new Map(),
  skillRoutes: new Map(),
  tokens: new Map(),
  opportunities: new Map(),
  detectedOpportunities: new Map(),
  sessions: new Map(),
  labeledSessions: new Map(),
  triage: new Map(),
  latency: new Map(),
  confidence: new Map(),
  noulProbability: new Map(),
  sessionOutcomes: new Map(),
  sessionWaste: new Map(),
  sessionFriction: new Map(),
  sessionCost: new Map(),
  sessionTokens: new Map(),
  sessionToolErrors: new Map(),
  sessionStopReasons: new Map(),
  reviews: new Map(),
  reviewScores: new Map(),
  reviewDirections: new Map(),
  latestLabel: new Map(),
  anonymousLabels: [],
});

const collectCall = (acc: EventAccumulator, event: CallEvent): void => {
  const entry = acc.calls.get(event.harness) ?? { ok: 0, error: 0 };
  if (event.status === "ok") entry.ok += 1;
  else {
    entry.error += 1;
    const reasonKey = `${event.harness}|${event.errorTag ?? "unknown"}`;
    acc.callErrors.set(reasonKey, (acc.callErrors.get(reasonKey) ?? 0) + 1);
  }
  acc.calls.set(event.harness, entry);

  const eventTokens = Option.fromUndefinedOr(event.tokens);
  if (Option.isSome(eventTokens)) {
    const tokenEntry = acc.tokens.get(event.harness) ?? { input: 0, output: 0 };
    tokenEntry.input += eventTokens.value.input;
    tokenEntry.output += eventTokens.value.output;
    acc.tokens.set(event.harness, tokenEntry);
  }

  const eventSession = Option.fromUndefinedOr(event.sessionID);
  if (Option.isSome(eventSession)) {
    const set = acc.sessions.get(event.harness) ?? new Set<string>();
    set.add(eventSession.value);
    acc.sessions.set(event.harness, set);
  }

  const latencyHistogram = acc.latency.get(event.harness) ?? newHistogram(LATENCY_BUCKETS);
  observe(latencyHistogram, LATENCY_BUCKETS, event.latencyMs / 1000);
  acc.latency.set(event.harness, latencyHistogram);

  const eventAnswers = Option.fromUndefinedOr(event.answers);
  if (Option.isSome(eventAnswers)) {
    for (const answer of Object.values(eventAnswers.value)) {
      if (answer._tag === "noul") {
        // A noul answer has no confidence field; its probability is the signal.
        const noulHistogram = acc.noulProbability.get(event.harness) ?? newHistogram(NOUL_BUCKETS);
        observe(noulHistogram, NOUL_BUCKETS, answer.noul);
        acc.noulProbability.set(event.harness, noulHistogram);
        continue;
      }
      const histogram = acc.confidence.get(answer._tag) ?? newHistogram(CONFIDENCE_BUCKETS);
      observe(histogram, CONFIDENCE_BUCKETS, answer.confidence);
      acc.confidence.set(answer._tag, histogram);
    }
  }
};

/** Skill-routing decisions by outcome: loaded versus declined. */
const collectRoute = (acc: EventAccumulator, event: RouteEvent): void => {
  acc.skillRoutes.set(event.outcome, (acc.skillRoutes.get(event.outcome) ?? 0) + 1);
};

/** A recovered call→session link counts the session as a Jev user. */
const collectAttribution = (acc: EventAccumulator, event: AttributionEvent): void => {
  const set = acc.sessions.get(event.harness) ?? new Set<string>();
  set.add(event.sessionID);
  acc.sessions.set(event.harness, set);
};

const collectOpportunity = (acc: EventAccumulator, event: OpportunityEvent): void => {
  // One detection = one message pattern; a later audit of the same window
  // refreshes the verdict instead of adding a second claim observation.
  const identity = [
    event.harness,
    event.sessionID ?? "",
    event.source,
    event.pattern,
    event.messageTs ?? event.ts,
  ].join("|");
  acc.detectedOpportunities.set(identity, event);
};

const finalizeOpportunities = (acc: EventAccumulator): void => {
  for (const event of acc.detectedOpportunities.values()) {
    const key = `${event.harness}|${event.source}`;
    const entry = acc.opportunities.get(key) ?? { matched: 0, missed: 0 };
    if (event.matched) entry.matched += 1;
    else entry.missed += 1;
    acc.opportunities.set(key, entry);
  }
};

const collectReview = (acc: EventAccumulator, event: ReviewEvent): void => {
  acc.reviews.set(event.harness, (acc.reviews.get(event.harness) ?? 0) + 1);
  for (const [dimension, result] of Object.entries(event.dimensions)) {
    const score = Option.fromUndefinedOr(result.score);
    if (!result.applicable || Option.isNone(score)) continue;
    const key = `${event.harness}|${dimension}`;
    const entry = acc.reviewScores.get(key) ?? { sum: 0, count: 0 };
    entry.sum += score.value;
    entry.count += 1;
    acc.reviewScores.set(key, entry);
    const direction = Option.fromUndefinedOr(result.direction);
    if (Option.isSome(direction)) {
      const directionKey = `${event.harness}|${direction.value}`;
      acc.reviewDirections.set(directionKey, (acc.reviewDirections.get(directionKey) ?? 0) + 1);
    }
  }
};

const collectSessionLabel = (acc: EventAccumulator, event: SessionLabelEvent): void => {
  const labeledSession = Option.fromUndefinedOr(event.sessionID);
  if (Option.isSome(labeledSession)) {
    const set = acc.labeledSessions.get(event.harness) ?? new Set<string>();
    set.add(labeledSession.value);
    acc.labeledSessions.set(event.harness, set);
    // Re-labeling overwrites: outcome/waste/friction follow the latest label.
    acc.latestLabel.set(`${event.harness}|${labeledSession.value}`, event);
  } else {
    acc.anonymousLabels.push(event);
  }
};

/** Digest facts carried by a label: cost, tokens, tool errors, stop reasons. */
const accumulateSessionFacts = (acc: EventAccumulator, label: SessionLabelEvent): void => {
  const cost = Option.fromUndefinedOr(label.costUsd);
  if (Option.isSome(cost)) {
    acc.sessionCost.set(label.harness, (acc.sessionCost.get(label.harness) ?? 0) + cost.value);
  }
  const tokens = Option.fromUndefinedOr(label.tokens);
  if (Option.isSome(tokens)) {
    const byKind = [
      ["input", tokens.value.input],
      ["output", tokens.value.output],
      ["cache_read", tokens.value.cacheRead],
      ["cache_write", tokens.value.cacheWrite],
    ] as const;
    for (const [kind, value] of byKind) {
      const tokenKey = `${label.harness}|${kind}`;
      acc.sessionTokens.set(tokenKey, (acc.sessionTokens.get(tokenKey) ?? 0) + value);
    }
  }
  const toolErrors = Option.fromUndefinedOr(label.toolErrors);
  if (Option.isSome(toolErrors)) {
    acc.sessionToolErrors.set(
      label.harness,
      (acc.sessionToolErrors.get(label.harness) ?? 0) + toolErrors.value,
    );
  }
  const stopReasons = Option.fromUndefinedOr(label.stopReasons);
  if (Option.isSome(stopReasons)) {
    for (const [reason, count] of Object.entries(stopReasons.value)) {
      const reasonKey = `${label.harness}|${reason}`;
      acc.sessionStopReasons.set(reasonKey, (acc.sessionStopReasons.get(reasonKey) ?? 0) + count);
    }
  }
};

/** One observation per labeled session (latest label wins); labels without a
 * session ID cannot be deduped and stay per-event. */
const finalizeSessionLabels = (acc: EventAccumulator): void => {
  for (const label of [...acc.latestLabel.values(), ...acc.anonymousLabels]) {
    const outcomeKey = `${label.harness}|${label.outcome}`;
    acc.sessionOutcomes.set(outcomeKey, (acc.sessionOutcomes.get(outcomeKey) ?? 0) + 1);
    const wasteKey = `${label.harness}|${label.waste}`;
    acc.sessionWaste.set(wasteKey, (acc.sessionWaste.get(wasteKey) ?? 0) + 1);
    const frictionHistogram =
      acc.sessionFriction.get(label.harness) ?? newHistogram(FRICTION_BUCKETS);
    observe(frictionHistogram, FRICTION_BUCKETS, label.friction);
    acc.sessionFriction.set(label.harness, frictionHistogram);
    accumulateSessionFacts(acc, label);
  }
};

/** Health families report what the meter knows about its own input and age. */
const healthFamilies = (health: MeterHealth | undefined): ReadonlyArray<MetricFamily> => {
  if (health === undefined) return [];
  const lastEventSeconds = Option.fromUndefinedOr(health.stats.lastEventTs).pipe(
    Option.map((ts) => Date.parse(ts)),
    Option.filter((ms) => Number.isFinite(ms)),
    Option.map((ms) => Math.round(ms / 1000)),
    Option.getOrElse(() => 0),
  );
  return [
    {
      name: "jev_log_lines_total",
      help: "Event log lines by decode status; skipped lines are malformed and ignored.",
      type: "counter",
      lines: [
        sample("jev_log_lines_total", [["status", "decoded"]], health.stats.decoded),
        sample("jev_log_lines_total", [["status", "skipped"]], health.stats.skipped),
      ],
    },
    {
      name: "jev_last_event_timestamp_seconds",
      help: "Unix seconds of the newest event in the log; 0 when the log is empty.",
      type: "gauge",
      lines: [sample("jev_last_event_timestamp_seconds", [], lastEventSeconds)],
    },
    {
      name: "jev_meter_start_timestamp_seconds",
      help:
        "Unix seconds when the meter process started; a start older than the " +
        "newest code change means the process serves stale code.",
      type: "gauge",
      lines: [
        sample("jev_meter_start_timestamp_seconds", [], Math.round(health.startedAtMs / 1000)),
      ],
    },
  ];
};

export function collect(events: ReadonlyArray<JevEvent>, health?: MeterHealth): MetricsSnapshot {
  const acc = newAccumulator();
  const {
    callErrors,
    calls,
    confidence,
    labeledSessions,
    latency,
    noulProbability,
    opportunities,
    reviews,
    reviewDirections,
    reviewScores,
    sessionCost,
    sessionFriction,
    sessionOutcomes,
    sessionStopReasons,
    sessionTokens,
    sessionToolErrors,
    sessionWaste,
    sessions,
    skillRoutes,
    tokens,
    triage,
  } = acc;

  for (const event of events) {
    switch (event._tag) {
      case "call":
        collectCall(acc, event);
        break;
      case "opportunity":
        collectOpportunity(acc, event);
        break;
      case "attribution":
        collectAttribution(acc, event);
        break;
      case "route":
        collectRoute(acc, event);
        break;
      case "triage":
        triage.set(event.feature, (triage.get(event.feature) ?? 0) + 1);
        break;
      case "review":
        collectReview(acc, event);
        break;
      case "session_label":
        collectSessionLabel(acc, event);
        break;
    }
  }

  finalizeSessionLabels(acc);
  finalizeOpportunities(acc);

  const families: Array<MetricFamily> = [
    {
      name: "jev_calls_total",
      help: "Jev calls by harness and status.",
      type: "counter",
      lines: sorted(calls).flatMap(([harness, counts]) => [
        sample(
          "jev_calls_total",
          [
            ["harness", harness],
            ["status", "ok"],
          ],
          counts.ok,
        ),
        sample(
          "jev_calls_total",
          [
            ["harness", harness],
            ["status", "error"],
          ],
          counts.error,
        ),
      ]),
    },
    {
      name: "jev_tokens_total",
      help: "TypeSafe tokens by harness and kind.",
      type: "counter",
      lines: sorted(tokens).flatMap(([harness, counts]) => [
        sample(
          "jev_tokens_total",
          [
            ["harness", harness],
            ["kind", "input"],
          ],
          counts.input,
        ),
        sample(
          "jev_tokens_total",
          [
            ["harness", harness],
            ["kind", "output"],
          ],
          counts.output,
        ),
      ]),
    },
    harnessCounter(
      "jev_sessions_with_calls_total",
      "Sessions with at least one Jev call, by harness.",
      sessions,
      (set) => set.size,
    ),
    harnessCounter(
      "jev_labeled_sessions_with_calls_total",
      "Labeled sessions that also recorded at least one Jev call, by harness.",
      labeledSessions,
      (set, harness) => {
        const called = sessions.get(harness) ?? new Set<string>();
        return [...set].filter((sessionID) => called.has(sessionID)).length;
      },
    ),
    harnessCounter(
      "jev_labeled_sessions_total",
      "Distinct labeled sessions by harness.",
      labeledSessions,
      (set) => set.size,
    ),
    {
      name: "jev_opportunities_total",
      help: "Detected quantitative claims, matched to Jev usage or missed.",
      type: "counter",
      lines: sorted(opportunities).flatMap(([key, counts]) => {
        const [harness, source] = splitKey(key);
        return [
          sample(
            "jev_opportunities_total",
            [
              ["harness", harness],
              ["source", source],
              ["matched", "true"],
            ],
            counts.matched,
          ),
          sample(
            "jev_opportunities_total",
            [
              ["harness", harness],
              ["source", source],
              ["matched", "false"],
            ],
            counts.missed,
          ),
        ];
      }),
    },
    {
      name: "jev_compliance_ratio",
      help: "Fraction of detected claims that went through Jev, by harness and source.",
      type: "gauge",
      lines: sorted(opportunities).map(([key, counts]) => {
        const [harness, source] = splitKey(key);
        const total = counts.matched + counts.missed;
        return sample(
          "jev_compliance_ratio",
          [
            ["harness", harness],
            ["source", source],
          ],
          total === 0 ? 0 : round(counts.matched / total),
        );
      }),
    },
    keyedFamily("jev_triage_total", "Triage runs by feature.", "counter", ["feature"], triage),
    {
      name: "jev_latency_seconds",
      help: "Jev call latency in seconds, by harness.",
      type: "histogram",
      lines: sorted(latency).flatMap(([harness, histogram]) =>
        histogramLines(
          "jev_latency_seconds",
          "le",
          [["harness", harness]],
          LATENCY_BUCKETS,
          histogram,
        ),
      ),
    },
    {
      name: "jev_confidence",
      help: "Answer confidence distribution by primitive.",
      type: "histogram",
      lines: sorted(confidence).flatMap(([primitive, histogram]) =>
        histogramLines(
          "jev_confidence",
          "le",
          [["primitive", primitive]],
          CONFIDENCE_BUCKETS,
          histogram,
        ),
      ),
    },
    {
      name: "jev_noul_probability",
      help: "Noul p(yes) distribution by harness; noul answers carry no confidence.",
      type: "histogram",
      lines: sorted(noulProbability).flatMap(([harness, histogram]) =>
        histogramLines(
          "jev_noul_probability",
          "le",
          [["harness", harness]],
          NOUL_BUCKETS,
          histogram,
        ),
      ),
    },
    keyedFamily(
      "jev_call_errors_total",
      "Failed calls by harness and typed failure tag; unknown covers pre-tag events.",
      "counter",
      ["harness", "reason"],
      callErrors,
    ),
    keyedFamily(
      "jev_sessions_total",
      "Labeled sessions by harness and outcome.",
      "counter",
      ["harness", "outcome"],
      sessionOutcomes,
    ),
    keyedFamily(
      "jev_waste_total",
      "Labeled sessions by dominant waste pattern.",
      "counter",
      ["harness", "pattern"],
      sessionWaste,
    ),
    {
      name: "jev_session_friction",
      help: "Session friction distribution by harness.",
      type: "histogram",
      lines: sorted(sessionFriction).flatMap(([harness, histogram]) =>
        histogramLines(
          "jev_session_friction",
          "le",
          [["harness", harness]],
          FRICTION_BUCKETS,
          histogram,
        ),
      ),
    },
    keyedFamily(
      "jev_session_cost_usd",
      "Summed agent session cost in USD by harness, from the latest label per session.",
      "gauge",
      ["harness"],
      sessionCost,
      round,
    ),
    keyedFamily(
      "jev_session_tokens_total",
      "Agent model tokens summed over labeled sessions by harness and kind.",
      "counter",
      ["harness", "kind"],
      sessionTokens,
    ),
    keyedFamily(
      "jev_session_tool_errors_total",
      "Tool errors reported by the harness, summed over labeled sessions.",
      "counter",
      ["harness"],
      sessionToolErrors,
    ),
    keyedFamily(
      "jev_session_stop_reasons_total",
      "Turn endings by stop reason over labeled sessions; length/error/aborted mean unfinished work.",
      "counter",
      ["harness", "reason"],
      sessionStopReasons,
    ),
    keyedFamily(
      "jev_reviews_total",
      "Quality review runs by harness.",
      "counter",
      ["harness"],
      reviews,
    ),
    keyedFamily(
      "jev_skill_routes_total",
      "Skill-routing decisions by outcome; decline reasons stay in the log, not in labels.",
      "counter",
      ["outcome"],
      skillRoutes,
    ),
    {
      name: "jev_review_score",
      help: "Mean applicable review score (normalized 0-1) by dimension and harness.",
      type: "gauge",
      lines: sorted(reviewScores).map(([key, entry]) => {
        const [harness, dimension] = splitKey(key);
        return sample(
          "jev_review_score",
          [
            ["dimension", dimension],
            ["harness", harness],
          ],
          entry.count === 0 ? 0 : round(entry.sum / entry.count),
        );
      }),
    },
    keyedFamily(
      "jev_review_direction_total",
      "Recorded review directions by harness.",
      "counter",
      ["harness", "direction"],
      reviewDirections,
    ),
  ];

  families.push(...healthFamilies(health));

  return { families };
}

export function render(snapshot: MetricsSnapshot): string {
  const lines: Array<string> = [];
  for (const family of snapshot.families) {
    lines.push(`# HELP ${family.name} ${family.help}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    lines.push(...family.lines);
  }
  return `${lines.join("\n")}\n`;
}

export function serveMeter(port: number, log: EventLogService): Effect.Effect<never, MeterError> {
  const respond = (
    response: ServerResponse,
    status: number,
    contentType: string,
    body: string,
  ): void => {
    response.writeHead(status, { "Content-Type": contentType });
    response.end(body);
  };

  return Effect.gen(function* () {
    const startedAtMs = yield* Clock.currentTimeMillis;
    return yield* Effect.scoped(
      Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const server = createServer((request, response) => {
              if (request.url === "/metrics") {
                void Effect.runPromise(log.scan()).then(
                  (result) => {
                    respond(
                      response,
                      200,
                      "text/plain; version=0.0.4",
                      render(collect(result.events, { startedAtMs, stats: result.stats })),
                    );
                  },
                  () => {
                    respond(response, 500, "text/plain", "event log read failed");
                  },
                );
                return;
              }
              if (request.url === "/health") {
                respond(response, 200, "text/plain", "ok");
                return;
              }
              respond(response, 404, "text/plain", "not found");
            });
            await new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(port, "127.0.0.1", () => resolve());
            });
            return server;
          },
          catch: () => new MeterError(),
        }),
        (server) =>
          Effect.sync(() => {
            server.close();
          }),
      ).pipe(Effect.flatMap(() => Effect.never)),
    );
  });
}
