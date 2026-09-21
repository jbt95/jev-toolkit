import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { stat } from "node:fs/promises";
import type { EventLogError, EventLogService } from "./events.ts";
import { isNotFoundError } from "./fs-errors.ts";
import { claudeProjectsDir, ompSessionsDir, opencodeDbPath, piSessionsDir } from "./paths.ts";
import type { Harness } from "./schema.ts";

/** Minimum Node version the CLI runs on (engines.node). */
const REQUIRED_NODE_MAJOR = 26;

/** How long the meter probe waits before the doctor calls it unreachable. */
const METER_PROBE_TIMEOUT_MS = 1_500;

/**
 * A session-store path the doctor could not inspect for a reason other than
 * absence. Only ENOENT means "not there yet"; permissions and I/O failures are
 * findings, not empty data.
 */
export class DoctorProbeError extends Data.TaggedError("DoctorProbeError")<{
  readonly path: string;
}> {}

/** Why the meter probe failed: the transport never answered, or it answered non-2xx. */
export type MeterProbeReason = "unreachable" | "status";

export class MeterProbeError extends Data.TaggedError("MeterProbeError")<{
  readonly port: number;
  readonly reason: MeterProbeReason;
}> {}

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly detail: string;
}

export interface SessionStoreFact {
  readonly harness: Harness;
  readonly path: string;
  readonly present: boolean;
  /** False when the probe failed for a reason other than absence. */
  readonly readable: boolean;
}

export interface MeterFact {
  readonly reachable: boolean;
  readonly address: string;
  /** Set when the probe failed, so the check can name the failure. */
  readonly reason?: MeterProbeReason;
  readonly startSeconds?: number;
  readonly lastEventSeconds?: number;
  readonly skippedLines?: number;
}

export interface DoctorFacts {
  readonly nodeVersion: string;
  readonly apiKeyPresent: boolean;
  readonly log: {
    readonly lines: number;
    readonly skipped: number;
    readonly lastEventTs?: string;
  };
  readonly nowMs: number;
  readonly meter: MeterFact;
  readonly sessionStores: ReadonlyArray<SessionStoreFact>;
}

export interface DoctorReport {
  readonly checks: ReadonlyArray<DoctorCheck>;
  readonly failures: number;
  readonly warnings: number;
}

/** Meter samples the doctor reads; absent samples stay undefined. */
export interface MeterMetrics {
  readonly startSeconds?: number;
  readonly lastEventSeconds?: number;
  readonly skippedLines?: number;
}

const formatAge = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

/** One Prometheus sample value by its exact name prefix, optional labels included. */
const sampleValue = (line: string, name: string): number | undefined => {
  if (!line.startsWith(name)) return undefined;
  const raw = line.slice(name.length).trim();
  if (raw.length === 0 || raw.startsWith("{")) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isNaN(value) ? undefined : value;
};

export const parseMeterMetrics = (text: string): MeterMetrics => {
  let startSeconds: number | undefined;
  let lastEventSeconds: number | undefined;
  let skippedLines: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const start = sampleValue(line, "jev_meter_start_timestamp_seconds");
    if (start !== undefined) startSeconds = start;
    const last = sampleValue(line, "jev_last_event_timestamp_seconds");
    if (last !== undefined) lastEventSeconds = last;
    const skipped = sampleValue(line, 'jev_log_lines_total{status="skipped"}');
    if (skipped !== undefined) skippedLines = skipped;
  }
  return { startSeconds, lastEventSeconds, skippedLines };
};

const nodeCheck = (facts: DoctorFacts): DoctorCheck => {
  const major = Number.parseInt(facts.nodeVersion.replace(/^v/, ""), 10);
  if (Number.isNaN(major) || major < REQUIRED_NODE_MAJOR) {
    return {
      name: "node",
      status: "fail",
      detail: `${facts.nodeVersion} is below the required Node ${REQUIRED_NODE_MAJOR}`,
    };
  }
  return { name: "node", status: "ok", detail: `${facts.nodeVersion} (needs >= 26)` };
};

const apiKeyCheck = (facts: DoctorFacts): DoctorCheck =>
  facts.apiKeyPresent
    ? { name: "api_key", status: "ok", detail: "TYPESAFE_API_KEY is set" }
    : {
        name: "api_key",
        status: "fail",
        detail: "TYPESAFE_API_KEY is not set; every judgment call fails with JevConfigError",
      };

const eventLogCheck = (facts: DoctorFacts): DoctorCheck => {
  if (facts.log.skipped > 0) {
    return {
      name: "event_log",
      status: "fail",
      detail: `${facts.log.skipped} malformed line(s) in the log; the meter skips them`,
    };
  }
  if (facts.log.lines === 0) {
    return { name: "event_log", status: "warn", detail: "no events yet" };
  }
  const age = Date.parse(facts.log.lastEventTs ?? "");
  const freshness = Number.isFinite(age) ? `, last event ${formatAge(facts.nowMs - age)} ago` : "";
  return {
    name: "event_log",
    status: "ok",
    detail: `${facts.log.lines} event(s)${freshness}`,
  };
};

const meterCheck = (facts: DoctorFacts): DoctorCheck => {
  const meter = facts.meter;
  if (!meter.reachable) {
    const why = meter.reason ?? "unreachable";
    return {
      name: "meter",
      status: "warn",
      detail: `not reachable at ${meter.address} (${why}; start it with: jev meter serve)`,
    };
  }
  if ((meter.skippedLines ?? 0) > 0) {
    return {
      name: "meter",
      status: "fail",
      detail: `meter reports ${meter.skippedLines} malformed log line(s)`,
    };
  }
  const logLast = Date.parse(facts.log.lastEventTs ?? "");
  const logLastSeconds = Number.isFinite(logLast) ? Math.floor(logLast / 1000) : undefined;
  if (
    logLastSeconds !== undefined &&
    meter.lastEventSeconds !== undefined &&
    meter.lastEventSeconds < logLastSeconds
  ) {
    return {
      name: "meter",
      status: "warn",
      detail: "meter serves a stale log view; restart it to load the current code and log",
    };
  }
  const started = meter.startSeconds;
  const age =
    started === undefined
      ? ""
      : `, started ${formatAge(facts.nowMs - started * 1000)} ago (restart after code changes)`;
  return { name: "meter", status: "ok", detail: `serving at ${meter.address}${age}` };
};

const sessionStoreCheck = (facts: DoctorFacts): DoctorCheck => {
  const unreadable = facts.sessionStores.filter((store) => !store.readable);
  if (unreadable.length > 0) {
    return {
      name: "session_stores",
      status: "fail",
      detail: unreadable
        .map((store) => `cannot read ${store.harness} store: ${store.path}`)
        .join("; "),
    };
  }
  const present = facts.sessionStores.filter((store) => store.present);
  const absent = facts.sessionStores.filter((store) => !store.present);
  const detail = [
    present.length > 0 ? `present: ${present.map((store) => store.harness).join(", ")}` : "",
    absent.length > 0 ? `absent: ${absent.map((store) => store.harness).join(", ")}` : "",
  ]
    .filter((part) => part.length > 0)
    .join("; ");
  if (present.length === 0) {
    return {
      name: "session_stores",
      status: "warn",
      detail: `no harness session store found (${detail}); audit and label have nothing to read`,
    };
  }
  return { name: "session_stores", status: "ok", detail };
};

/**
 * True when the path exists. Only ENOENT means "not there yet"; a permission or
 * I/O failure is a `DoctorProbeError` the report can name.
 */
const pathPresent = (path: string): Effect.Effect<boolean, DoctorProbeError> =>
  Effect.tryPromise({
    try: async () => {
      await stat(path);
      return true;
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catchIf(isNotFoundError, () => Effect.succeed(false)),
    Effect.mapError(() => new DoctorProbeError({ path })),
  );

/**
 * One loopback probe of the meter's exposition. A transport failure and a
 * non-2xx answer are different findings, so each keeps its own reason.
 */
const fetchMeterMetrics = (port: number): Effect.Effect<string, MeterProbeError> =>
  Effect.gen(function* fetchMeterMetricsProgram() {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`http://127.0.0.1:${port}/metrics`, {
          signal: AbortSignal.timeout(METER_PROBE_TIMEOUT_MS),
        }),
      catch: () => new MeterProbeError({ port, reason: "unreachable" }),
    });
    if (!response.ok) {
      return yield* Effect.fail(new MeterProbeError({ port, reason: "status" }));
    }
    return yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new MeterProbeError({ port, reason: "unreachable" }),
    });
  });

/** The harness stores the doctor inspects, in report order. */
const sessionStorePaths = (): ReadonlyArray<{
  readonly harness: Harness;
  readonly path: string;
}> => [
  { harness: "opencode", path: opencodeDbPath() },
  { harness: "claude-code", path: claudeProjectsDir() },
  { harness: "pi", path: piSessionsDir() },
  { harness: "omp", path: ompSessionsDir() },
];

/**
 * Collect the facts the report is built from: log health, the meter probe, and
 * the harness session stores. Environment state (Node version, API-key
 * presence) and harness paths are read here because the environment is what the
 * doctor diagnoses — the key itself never leaves this function, only a boolean.
 * Probe failures become facts; only a log read failure reaches the error
 * channel, and the caller maps it to a message.
 */
export const collectDoctorFacts = (
  log: EventLogService,
  meterPort: number,
): Effect.Effect<DoctorFacts, EventLogError> =>
  Effect.gen(function* collectDoctorFactsProgram() {
    const scan = yield* log.scan();
    const probe = yield* Effect.result(fetchMeterMetrics(meterPort));
    const metrics = probe._tag === "Success" ? Option.some(probe.success) : Option.none<string>();
    const parsed = Option.match(metrics, {
      onNone: () => undefined,
      onSome: (text) => parseMeterMetrics(text),
    });
    const sessionStores: Array<SessionStoreFact> = [];
    for (const store of sessionStorePaths()) {
      const presence = yield* Effect.result(pathPresent(store.path));
      sessionStores.push(
        presence._tag === "Success"
          ? { ...store, present: presence.success, readable: true }
          : { ...store, present: false, readable: false },
      );
    }
    const nowMs = yield* Clock.currentTimeMillis;
    return {
      nodeVersion: process.version,
      apiKeyPresent: Option.fromUndefinedOr(process.env.TYPESAFE_API_KEY).pipe(
        Option.exists((value) => value.length > 0),
      ),
      log: {
        lines: scan.stats.lines,
        skipped: scan.stats.skipped,
        lastEventTs: scan.stats.lastEventTs,
      },
      nowMs,
      meter: {
        reachable: Option.isSome(metrics),
        address: `127.0.0.1:${meterPort}`,
        reason: probe._tag === "Failure" ? probe.failure.reason : undefined,
        startSeconds: parsed?.startSeconds,
        lastEventSeconds: parsed?.lastEventSeconds,
        skippedLines: parsed?.skippedLines,
      },
      sessionStores,
    };
  });

/**
 * Turn collected facts into a doctor report. Every check is a pure function of
 * the facts, so collection (`collectDoctorFacts`) and tests stay independent of
 * the report shape.
 */
export const buildDoctorReport = (facts: DoctorFacts): DoctorReport => {
  const checks = [
    nodeCheck(facts),
    apiKeyCheck(facts),
    eventLogCheck(facts),
    meterCheck(facts),
    sessionStoreCheck(facts),
  ];
  return {
    checks,
    failures: checks.filter((check) => check.status === "fail").length,
    warnings: checks.filter((check) => check.status === "warn").length,
  };
};
