import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { createServer, type ServerResponse } from "node:http";
import type { EventLogService } from "./events.ts";
import type { JevEvent } from "./schema.ts";

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

const CONFIDENCE_BUCKETS = [0.5, 0.7, 0.8, 0.9, 0.95, 0.99, 1] as const;
const LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10] as const;

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

export function collect(events: ReadonlyArray<JevEvent>): MetricsSnapshot {
  const calls = new Map<string, { ok: number; error: number }>();
  const tokens = new Map<string, { input: number; output: number }>();
  const opportunities = new Map<string, { matched: number; missed: number }>();
  const sessions = new Map<string, Set<string>>();
  const triage = new Map<string, number>();
  const latency = new Map<string, Histogram>();
  const confidence = new Map<string, Histogram>();

  for (const event of events) {
    switch (event._tag) {
      case "call": {
        const entry = calls.get(event.harness) ?? { ok: 0, error: 0 };
        if (event.status === "ok") entry.ok += 1;
        else entry.error += 1;
        calls.set(event.harness, entry);
        if (event.tokens !== undefined) {
          const tokenEntry = tokens.get(event.harness) ?? { input: 0, output: 0 };
          tokenEntry.input += event.tokens.input;
          tokenEntry.output += event.tokens.output;
          tokens.set(event.harness, tokenEntry);
        }
        if (event.sessionID !== undefined) {
          const set = sessions.get(event.harness) ?? new Set<string>();
          set.add(event.sessionID);
          sessions.set(event.harness, set);
        }
        const latencyHistogram = latency.get(event.harness) ?? newHistogram(LATENCY_BUCKETS);
        observe(latencyHistogram, LATENCY_BUCKETS, event.latencyMs / 1000);
        latency.set(event.harness, latencyHistogram);
        if (event.answers !== undefined) {
          for (const answer of Object.values(event.answers)) {
            if (answer._tag === "noul") continue;
            const histogram = confidence.get(answer._tag) ?? newHistogram(CONFIDENCE_BUCKETS);
            observe(histogram, CONFIDENCE_BUCKETS, answer.confidence);
            confidence.set(answer._tag, histogram);
          }
        }
        break;
      }
      case "opportunity": {
        const entry = opportunities.get(event.harness) ?? { matched: 0, missed: 0 };
        if (event.matched) entry.matched += 1;
        else entry.missed += 1;
        opportunities.set(event.harness, entry);
        break;
      }
      case "triage": {
        triage.set(event.feature, (triage.get(event.feature) ?? 0) + 1);
        break;
      }
      case "session_label": {
        break;
      }
    }
  }

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
    {
      name: "jev_sessions_with_calls_total",
      help: "Sessions with at least one Jev call, by harness.",
      type: "counter",
      lines: sorted(sessions).map(([harness, set]) =>
        sample("jev_sessions_with_calls_total", [["harness", harness]], set.size),
      ),
    },
    {
      name: "jev_opportunities_total",
      help: "Detected quantitative claims, matched to Jev usage or missed.",
      type: "counter",
      lines: sorted(opportunities).flatMap(([harness, counts]) => [
        sample(
          "jev_opportunities_total",
          [
            ["harness", harness],
            ["matched", "true"],
          ],
          counts.matched,
        ),
        sample(
          "jev_opportunities_total",
          [
            ["harness", harness],
            ["matched", "false"],
          ],
          counts.missed,
        ),
      ]),
    },
    {
      name: "jev_compliance_ratio",
      help: "Fraction of detected claims that went through Jev, by harness.",
      type: "gauge",
      lines: sorted(opportunities).map(([harness, counts]) => {
        const total = counts.matched + counts.missed;
        return sample(
          "jev_compliance_ratio",
          [["harness", harness]],
          total === 0 ? 0 : round(counts.matched / total),
        );
      }),
    },
    {
      name: "jev_triage_total",
      help: "Triage runs by feature.",
      type: "counter",
      lines: sorted(triage).map(([feature, count]) =>
        sample("jev_triage_total", [["feature", feature]], count),
      ),
    },
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
  ];

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

  return Effect.scoped(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const server = createServer((request, response) => {
            if (request.url === "/metrics") {
              void Effect.runPromise(log.read()).then(
                (events) => {
                  respond(response, 200, "text/plain; version=0.0.4", render(collect(events)));
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
}
