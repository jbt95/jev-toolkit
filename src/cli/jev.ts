import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  extractClaude,
  extractOpencode,
  extractPiOmp,
  toDetectedOpportunity,
  type AuditError,
  type CorrelatedOpportunity,
  type DetectedOpportunity,
  type PiOmpRoot,
  type RawMessage,
} from "../audit/opportunities.ts";
import {
  attributeCalls,
  loadOpencodeTurns,
  loadPiOmpTurns,
  type SessionTurn,
} from "../audit/attribution.ts";
import {
  digestClaude,
  digestOpencode,
  digestPiOmp,
  type SessionAuditError,
  type SessionDigest,
} from "../audit/sessions.ts";
import { choiceOf, noulOf, noulValue, scoreValue } from "../core/answers.ts";
import { JevClient, describeJevError, formatAnswers, type AskResult } from "../core/client.ts";
import { JevClientSdkLive, sdkBaseURL } from "../core/sdk-client.ts";
import { matchQuantitativeClaim } from "../core/detector.ts";
import { CONTEXT_POLICY, PROMPT_DIRECTIVE } from "../core/directives.ts";
import { EventLog, EventLogLive, type EventLogService } from "../core/events.ts";
import {
  LoopGuard,
  LoopGuardLive,
  fingerprint,
  type LoopCheck,
  type LoopGuardService,
} from "../core/loops.ts";
import { serveMeter } from "../core/metrics.ts";
import { buildImpactReport, type ImpactReport, type ImpactStats } from "../core/impact.ts";
import { buildDoctorReport, collectDoctorFacts, type DoctorReport } from "../core/doctor.ts";
import { readSkillCatalog } from "../core/skills.ts";
import {
  apiEndpoint,
  claudeProjectsDir,
  eventsPath,
  loopStatePath,
  ompSessionsDir,
  opencodeDbPath,
  piSessionsDir,
} from "../core/paths.ts";
import { EventTag, Harness, QuestionMap, type CallEvent, type JevEvent } from "../core/schema.ts";
import { clip, redact, stripFencedCode } from "../core/text.ts";
import { transcriptFailureCandidates } from "../core/transcript.ts";
import { createMcpDeps, serveMcp, type JevAsk } from "../mcp/server.ts";
import { runPackLab, type PackLabReport } from "../eval/pack-lab.ts";
import {
  compareToBaseline,
  decodeBaselineReport,
  type BaselineComparison,
  type BaselineReport,
} from "../eval/baseline.ts";
import {
  planSkillFollowUp,
  skillChain,
  skillRoute,
  skillRouteQuestions,
} from "../question-packs/skill-routing.ts";
import { claimAlignmentQuestions, alignedIndexes } from "../question-packs/claim-alignment.ts";
import {
  claimDetectionQuestions,
  detectedClaims,
  type DetectedClaim,
} from "../question-packs/claim-detection.ts";
import {
  commitQuestions,
  verdictFor,
  type CommitVerdict,
} from "../question-packs/commit-conformance.ts";
import {
  failureQuestions,
  identityQuestions,
  transcriptSelectionQuestions,
} from "../question-packs/failure-triage.ts";
import { ReviewInput, reviewQuestions, routeTriage } from "../question-packs/reviewer-triage.ts";
import { labelQuestions } from "../question-packs/session-labeling.ts";

const AskPayload = Schema.Struct({
  state: Schema.Json,
  questions: QuestionMap,
  model: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  sessionID: Schema.optional(Schema.NonEmptyString),
});
const decodeAskPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(AskPayload));

const HookInput = Schema.Struct({
  prompt: Schema.String,
  session_id: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
});
const decodeHookInput = Schema.decodeUnknownOption(Schema.fromJsonString(HookInput));

const USAGE = `usage: jev <command>

commands:
  ask      read {state, questions, model?} JSON on stdin and print TypeSafe answers
  events   print recent events as JSON lines ([--n N] [--harness H] [--since 24h] [--type T] [--session ID])
  audit    scan harness stores for quantitative claims: jev audit run [--since 24h] [--dry-run]
  hook     harness hooks: jev hook prompt [--verify] | jev hook context
  check    commit conformance: jev check commit --message-file FILE
  label    session labeling: jev label sessions [--since 24h] [--dry-run]
  impact   compare Jev-assisted and unassisted sessions: jev impact [--since 7d] [--json]
  doctor   check local setup and health: jev doctor [--json]
  route    pick the skill for a task: jev route skills --task TEXT --skills-dir DIR
  triage   classify failures or review findings: jev triage failure | review
  eval     replay labeled fixtures through a pack: jev eval pack --fixtures FILE
  mcp      stdio MCP server exposing typesafe_ask, typesafe_verify, typesafe_review, typesafe_skill_route
  meter    serve Prometheus metrics: jev meter serve [--port N]`;

const readStdin = (): Effect.Effect<string, string> =>
  Effect.tryPromise({
    try: async () => {
      const chunks: Array<string> = [];
      for await (const chunk of process.stdin) {
        chunks.push(String(chunk));
      }
      return chunks.join("");
    },
    catch: () => "failed to read stdin",
  });

const flag = (argv: ReadonlyArray<string>, name: string): Option.Option<string> => {
  const index = argv.indexOf(name);
  if (index === -1) return Option.none();
  return Option.fromUndefinedOr(argv[index + 1]);
};

/** Parse an `Nh`/`Nd` window; malformed input is a usage error, never a silent default. */
const parseSinceMs = (value: string): Option.Option<number> => {
  const match = /^(\d+)([hd])$/.exec(value);
  if (match === null) return Option.none();
  const amount = Number.parseInt(match[1] ?? "", 10);
  if (Number.isNaN(amount)) return Option.none();
  return Option.some(match[2] === "h" ? amount * 60 * 60 * 1000 : amount * 24 * 60 * 60 * 1000);
};

/** The `--since` window in milliseconds, or a failure naming the bad value. */
const sinceWindowMs = (
  rest: ReadonlyArray<string>,
  fallback: string,
): Effect.Effect<number, string> =>
  Effect.gen(function* sinceWindowMsProgram() {
    const raw = flag(rest, "--since").pipe(Option.getOrElse(() => fallback));
    const parsed = parseSinceMs(raw);
    if (Option.isNone(parsed)) {
      return yield* Effect.fail(`invalid --since: ${raw} (use Nh or Nd, for example 24h or 7d)`);
    }
    return parsed.value;
  });

/**
 * The `--harness` filter as a harness tag, or none for `all`. An unknown value
 * fails: silently dropping the filter would widen a report without saying so.
 */
const harnessFilterValue = (
  rest: ReadonlyArray<string>,
  fallback: string,
): Effect.Effect<Option.Option<Harness>, string> =>
  Effect.gen(function* harnessFilterValueProgram() {
    const raw = flag(rest, "--harness").pipe(Option.getOrElse(() => fallback));
    if (raw === "all") return Option.none<Harness>();
    const decoded = Schema.decodeUnknownOption(Harness)(raw);
    if (Option.isNone(decoded)) {
      return yield* Effect.fail(
        `unknown harness: ${raw} (use all, opencode, claude-code, pi, omp)`,
      );
    }
    return Option.some(decoded.value);
  });

const printAuditSummary = (
  input: {
    readonly messages: ReadonlyArray<RawMessage>;
    readonly correlated: ReadonlyArray<CorrelatedOpportunity>;
  },
  dryRun: boolean,
): void => {
  const perHarness = new Map<string, { messages: number; detected: number; matched: number }>();
  const entryFor = (harness: string) => {
    const existing = perHarness.get(harness) ?? { messages: 0, detected: 0, matched: 0 };
    perHarness.set(harness, existing);
    return existing;
  };
  for (const item of input.messages) entryFor(item.harness).messages += 1;
  for (const item of input.correlated) {
    const entry = entryFor(item.harness);
    entry.detected += 1;
    if (item.matched) entry.matched += 1;
  }
  console.log(
    `harness        messages detected matched missed compliance${dryRun ? " (dry run)" : ""}`,
  );
  const rows = [...perHarness.entries()].sort(([a], [b]) => a.localeCompare(b));
  let messageTotal = 0;
  let detectedTotal = 0;
  let matchedTotal = 0;
  for (const [harness, counts] of rows) {
    messageTotal += counts.messages;
    detectedTotal += counts.detected;
    matchedTotal += counts.matched;
    const missed = counts.detected - counts.matched;
    const compliance =
      counts.detected === 0 ? "0.0%" : `${((counts.matched / counts.detected) * 100).toFixed(1)}%`;
    console.log(
      `${harness.padEnd(15)}${String(counts.messages).padEnd(9)}${String(counts.detected).padEnd(10)}${String(counts.matched).padEnd(8)}${String(missed).padEnd(7)}${compliance}`,
    );
  }
  const rate =
    messageTotal === 0 ? "0.0%" : `${((detectedTotal / messageTotal) * 100).toFixed(1)}%`;
  console.log(
    `total: messages=${messageTotal} detected=${detectedTotal} matched=${matchedTotal} (detection rate ${rate})`,
  );
};

const printPromptSummary = (input: {
  readonly prompts: number;
  readonly regexTagged: number;
  readonly detected: number;
  readonly missed: number;
  readonly missedExamples: ReadonlyArray<string>;
  readonly detectedExamples: ReadonlyArray<string>;
  readonly noiseExamples: ReadonlyArray<string>;
}): void => {
  const noise = input.regexTagged - (input.detected - input.missed);
  console.log(
    `prompts=${input.prompts} regex_tagged=${input.regexTagged} jev_detected=${input.detected} missed_by_regex=${input.missed} regex_noise=${noise}`,
  );
  if (input.missedExamples.length > 0) {
    console.log("missed by regex (examples):");
    for (const example of input.missedExamples) console.log(`  - ${example}`);
  }
  if (input.detectedExamples.length > 0) {
    console.log("routed by Jev (examples):");
    for (const example of input.detectedExamples) console.log(`  - ${example}`);
  }
  if (input.noiseExamples.length > 0) {
    console.log("regex-tagged but not routed by Jev (examples):");
    for (const example of input.noiseExamples) console.log(`  - ${example}`);
  }
};

const execFileAsync = promisify(execFile);

interface GitCommit {
  readonly hash: string;
  readonly subject: string;
  readonly body: string;
}

const gitLog = async (repo: string, count: number): Promise<ReadonlyArray<GitCommit>> => {
  const { stdout } = await execFileAsync(
    "git",
    ["log", `-${count}`, "--pretty=format:%H%x1f%s%x1f%B%x1e"],
    { cwd: repo, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [hash = "", subject = "", body = ""] = entry.split("\x1f");
      return { hash, subject, body };
    });
};

/** Harness id from JEV_HARNESS when valid, else the fallback. */
const harnessFromEnv = (fallback: Harness): Harness =>
  Option.fromUndefinedOr(process.env.JEV_HARNESS).pipe(
    Option.flatMap((value) => Schema.decodeUnknownOption(Harness)(value)),
    Option.getOrElse(() => fallback),
  );

export type CliServices = JevClient | EventLog | LoopGuard;

/** Precision gate for the prompt hook: confirm a regex hit with Jev. */
const hookVerifyEnabled = (rest: ReadonlyArray<string>): boolean =>
  rest.includes("--verify") ||
  Option.fromUndefinedOr(process.env.JEV_HOOK_VERIFY).pipe(Option.exists((value) => value === "1"));

const runHook = (
  rest: ReadonlyArray<string>,
  stdin: () => Effect.Effect<string, string>,
): Effect.Effect<number, string, CliServices> =>
  Effect.gen(function* runHookProgram() {
    if (rest[0] === "context") {
      yield* Effect.sync(() => {
        console.log(CONTEXT_POLICY);
      });
      return 0;
    }
    if (rest[0] !== "prompt") {
      yield* Effect.sync(() => {
        console.error("usage: jev hook prompt [--verify] | jev hook context");
      });
      return 1;
    }
    const raw = yield* stdin();
    const decoded = decodeHookInput(raw);
    if (Option.isNone(decoded)) return 0;
    const hits = matchQuantitativeClaim(decoded.value.prompt);
    if (hits.length === 0) return 0;
    if (!hookVerifyEnabled(rest)) {
      yield* Effect.sync(() => {
        console.log(PROMPT_DIRECTIVE);
      });
      return 0;
    }
    // The regex is a recall prefilter; Jev (via the SDK-backed client) decides
    // whether the prompt really asks for a routed judgment. Fail open: when
    // Jev is unreachable the directive still prints and the hook never blocks.
    const client = yield* JevClient;
    const harness = harnessFromEnv("cli");
    const safePrompt = clip(stripFencedCode(redact(decoded.value.prompt)), 2000);
    const outcome = yield* Effect.result(
      client.ask({
        harness,
        state: { messages: [{ id: "m0", text: safePrompt }] },
        questions: claimDetectionQuestions({ count: 1, subject: "user_prompt" }),
      }),
    );
    if (outcome._tag === "Failure") {
      yield* Effect.sync(() => {
        console.log(PROMPT_DIRECTIVE);
      });
      return 0;
    }
    if (detectedClaims(outcome.success.answers, 1).length === 0) return 0;
    yield* Effect.sync(() => {
      console.log(PROMPT_DIRECTIVE);
    });
    return 0;
  });

const runImpact = (rest: ReadonlyArray<string>): Effect.Effect<number, string, CliServices> =>
  Effect.gen(function* runImpactProgram() {
    const selectedHarness = yield* harnessFilterValue(rest, "all");
    const sinceMs = yield* sinceWindowMs(rest, "7d");
    const now = yield* Clock.currentTimeMillis;
    const since = new Date(now - sinceMs).toISOString();
    const log = yield* EventLog;
    const events = yield* log
      .read({
        since,
        harness: Option.getOrUndefined(selectedHarness),
      })
      .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
    const report = buildImpactReport(events, {
      since,
      harness: Option.getOrUndefined(selectedHarness),
    });
    yield* Effect.sync(() => {
      if (rest.includes("--json")) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      printImpactReport(report);
    });
    return 0;
  });

const formatImpactStats = (stats: ImpactStats): string =>
  `sessions=${stats.sessions} shipped=${stats.outcomes.shipped} ` +
  `blocked=${stats.outcomes.blocked} abandoned=${stats.outcomes.abandoned} ` +
  `ongoing=${stats.outcomes.ongoing} friction_mean=${stats.friction.mean === null ? "n/a" : stats.friction.mean.toFixed(2)} ` +
  `cost_usd=${stats.cost.totalUsd.toFixed(2)} (${stats.cost.sessions} observed) ` +
  `tool_errors=${stats.toolErrors.total} (${stats.toolErrors.sessions} observed)`;

const printImpactReport = (report: ImpactReport): void => {
  console.log(
    `since: ${report.since ?? "all events"}${report.harness === null ? "" : ` harness=${report.harness}`}`,
  );
  console.log(
    `coverage: identified_labels=${report.coverage.identifiedLabeledSessions} ` +
      `anonymous_labels=${report.coverage.anonymousLabeledSessions} ` +
      `assisted_labels=${report.coverage.assistedLabeledSessions} ` +
      `unassisted_labels=${report.coverage.unassistedLabeledSessions}`,
  );
  console.log(
    `calls: total=${report.coverage.callEvents} ` +
      `with_session=${report.coverage.callsWithSessionID} ` +
      `without_session=${report.coverage.callsWithoutSessionID} ` +
      `attributed_sessions=${report.coverage.attributedSessions} ` +
      `sessions_with_calls=${report.coverage.sessionsWithCalls}`,
  );
  console.log(
    `missing label facts: cost=${report.coverage.labelsMissingCost} ` +
      `tool_errors=${report.coverage.labelsMissingToolErrors} ` +
      `stop_reasons=${report.coverage.labelsMissingStopReasons}`,
  );
  if (report.comparisons.length === 0) {
    console.log("cohorts: none");
    return;
  }
  for (const comparison of report.comparisons) {
    console.log(`cohort: ${comparison.harness} task=${comparison.taskType}`);
    console.log(`  assisted:   ${formatImpactStats(comparison.assisted)}`);
    console.log(`  unassisted: ${formatImpactStats(comparison.unassisted)}`);
  }
};

const printDoctorReport = (report: DoctorReport): void => {
  const width = Math.max(...report.checks.map((check) => check.name.length));
  for (const check of report.checks) {
    console.log(`${check.status.padEnd(4)} ${check.name.padEnd(width)} ${check.detail}`);
  }
  console.log(
    `checks: ${report.checks.length} failures=${report.failures} warnings=${report.warnings}`,
  );
};

const runDoctor = (rest: ReadonlyArray<string>): Effect.Effect<number, string, CliServices> =>
  Effect.gen(function* runDoctorProgram() {
    const log = yield* EventLog;
    const requestedPort = Number.parseInt(
      Option.firstSomeOf([
        flag(rest, "--meter-port"),
        Option.fromUndefinedOr(process.env.JEV_METER_PORT),
      ]).pipe(Option.getOrElse(() => "8788")),
      10,
    );
    const meterPort = Number.isNaN(requestedPort) ? 8788 : requestedPort;
    const facts = yield* collectDoctorFacts(log, meterPort).pipe(
      Effect.mapError((error) => `event log ${error.operation} failed`),
    );
    const report = buildDoctorReport(facts);
    yield* Effect.sync(() => {
      if (rest.includes("--json")) console.log(JSON.stringify(report, null, 2));
      else printDoctorReport(report);
    });
    return report.failures === 0 ? 0 : 1;
  });

/** `jev events`: the log tail with combined filters; every filter value is validated. */
const runEvents = (rest: ReadonlyArray<string>): Effect.Effect<number, string, CliServices> =>
  Effect.gen(function* runEventsProgram() {
    const log = yield* EventLog;
    const selectedHarness = yield* harnessFilterValue(rest, "all");
    const requested = Number.parseInt(flag(rest, "--n").pipe(Option.getOrElse(() => "10")), 10);
    const limit = Number.isNaN(requested) ? 10 : requested;
    const sinceRaw = flag(rest, "--since");
    const now = yield* Clock.currentTimeMillis;
    const since = Option.flatMap(sinceRaw, (raw) =>
      Option.map(parseSinceMs(raw), (ms) => new Date(now - ms).toISOString()),
    ).pipe(Option.getOrUndefined);
    if (Option.isSome(sinceRaw) && since === undefined) {
      return yield* Effect.fail(
        `invalid --since: ${sinceRaw.value} (use Nh or Nd, for example 24h or 7d)`,
      );
    }
    const typeFlag = flag(rest, "--type");
    const wantedTag = Option.flatMap(typeFlag, (tag) => Schema.decodeUnknownOption(EventTag)(tag));
    if (Option.isSome(typeFlag) && Option.isNone(wantedTag)) {
      return yield* Effect.fail(
        `unknown --type: ${typeFlag.value} (use call, opportunity, triage, session_label, review, attribution, route)`,
      );
    }
    const session = flag(rest, "--session");
    const events = yield* log
      .read({ harness: Option.getOrUndefined(selectedHarness), since })
      .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
    const matching = events.filter(
      (event) =>
        Option.match(wantedTag, { onNone: () => true, onSome: (tag) => event._tag === tag }) &&
        Option.match(session, { onNone: () => true, onSome: (id) => event.sessionID === id }),
    );
    const tail = matching.slice(-limit);
    yield* Effect.sync(() => {
      for (const event of tail) console.log(JSON.stringify(event));
    });
    return 0;
  });

const runMeter = (rest: ReadonlyArray<string>): Effect.Effect<number, string, CliServices> =>
  Effect.gen(function* runMeterProgram() {
    if (rest[0] !== "serve") {
      yield* Effect.sync(() => {
        console.error("usage: jev meter serve [--port N]");
      });
      return 1;
    }
    const log = yield* EventLog;
    const port = Option.firstSomeOf([
      flag(rest, "--port"),
      Option.fromUndefinedOr(process.env.JEV_METER_PORT),
    ]).pipe(
      Option.map((raw) => Number.parseInt(raw, 10)),
      Option.filter((parsed) => !Number.isNaN(parsed)),
      Option.getOrElse(() => 8788),
    );
    return yield* serveMeter(port, log).pipe(
      Effect.mapError(() => "meter failed to start (port in use?)"),
    );
  });

export function runCli(
  argv: ReadonlyArray<string>,
  layers: Layer.Layer<CliServices>,
  stdin: () => Effect.Effect<string, string> = readStdin,
): Effect.Effect<number> {
  const [command, ...rest] = argv;

  const program: Effect.Effect<number, string, CliServices> = Effect.gen(
    function* dispatchProgram() {
      switch (command) {
        case "ask": {
          const client = yield* JevClient;
          const raw = yield* stdin();
          const payload = yield* decodeAskPayload(raw).pipe(
            Effect.mapError(
              () => "invalid ask payload on stdin: expected {state, questions, model?, sessionID?}",
            ),
          );
          const harness = harnessFromEnv("cli");
          const result = yield* client
            .ask({
              harness,
              state: payload.state,
              questions: payload.questions,
              model: Option.getOrUndefined(Option.fromNullishOr(payload.model)),
              sessionID: payload.sessionID,
            })
            .pipe(Effect.mapError(describeJevError));
          yield* Effect.sync(() => {
            console.log(formatAnswers(result, payload.questions));
          });
          return 0;
        }
        case "events": {
          return yield* runEvents(rest);
        }
        case "audit": {
          return yield* runAudit(rest);
        }
        case "label": {
          return yield* runLabel(rest);
        }
        case "impact": {
          return yield* runImpact(rest);
        }
        case "doctor": {
          return yield* runDoctor(rest);
        }
        case "check": {
          return yield* runCheck(rest);
        }
        case "triage": {
          return yield* runTriage(rest, stdin);
        }
        case "eval": {
          return yield* runEval(rest);
        }
        case "hook": {
          return yield* runHook(rest, stdin);
        }
        case "mcp": {
          const client = yield* JevClient;
          const log = yield* EventLog;
          const harness = harnessFromEnv("script");
          yield* Effect.tryPromise({
            try: () => serveMcp(createMcpDeps({ harness, ask: client.ask, log })),
            catch: () => "mcp server failed",
          });
          return 0;
        }
        case "meter": {
          return yield* runMeter(rest);
        }
        case "route": {
          return yield* runRoute(rest);
        }
        default: {
          yield* Effect.sync(() => {
            console.error(USAGE);
          });
          return 1;
        }
      }
    },
  );

  return Effect.gen(function* runCliProgram() {
    const outcome = yield* Effect.result(program);
    if (outcome._tag === "Success") return outcome.success;
    yield* Effect.sync(() => {
      console.error(outcome.failure);
    });
    return 1;
  }).pipe(Effect.provide(layers));
}

const printPackLab = (report: PackLabReport): void => {
  console.log(
    `pack ${report.pack}  cases ${report.cases.length}  repeat ${report.repeat}  model ${report.model}`,
  );
  for (const entry of report.cases) {
    const expectation =
      entry.expected === undefined
        ? ""
        : ` expected=${JSON.stringify(entry.expected)} agree=${entry.agreed === true ? "yes" : "no"}`;
    const confidence =
      entry.meanConfidence === undefined ? "" : ` conf=${entry.meanConfidence.toFixed(2)}`;
    const unstable =
      entry.unstableAnswers.length === 0 ? "" : ` unstable=${entry.unstableAnswers.join(",")}`;
    console.log(
      `${entry.id}: ${JSON.stringify(entry.summary)}${expectation}${confidence} ` +
        `spread=${entry.maxSpread.toFixed(2)}${unstable} tokens=${entry.inputTokens}/${entry.outputTokens} latency=${entry.latencyMs}ms`,
    );
  }
  console.log(
    `total: compared=${report.compared} agreed=${report.agreed} ` +
      `tokens=${report.inputTokens} in / ${report.outputTokens} out mean_latency_ms=${report.meanLatencyMs}`,
  );
};

const printBaselineComparison = (comparison: BaselineComparison): void => {
  console.log(
    `baseline: ${comparison.baselineModel} -> ${comparison.currentModel} ` +
      `shared=${comparison.sharedCases} new=${comparison.newCases.length} missing=${comparison.missingCases.length}`,
  );
  console.log(
    `regressions: ${comparison.regressions.length === 0 ? "none" : comparison.regressions.join(", ")}`,
  );
  if (comparison.drift.length === 0) {
    console.log("drift: none");
    return;
  }
  for (const entry of comparison.drift) {
    console.log(`drift: ${entry.id}/${entry.key} ${entry.before} -> ${entry.after}`);
  }
};

const EVAL_USAGE =
  "usage: jev eval pack --fixtures FILE [--repeat N] [--model MODEL] [--baseline FILE] [--fail-on regression|drift] [--json]";

type EvalFailOn = "regression" | "drift";

/** `--fail-on` as a gate policy, or a failure naming the accepted values. */
const parseEvalFailOn = (
  rest: ReadonlyArray<string>,
): Effect.Effect<Option.Option<EvalFailOn>, string> =>
  Effect.gen(function* parseEvalFailOnProgram() {
    const raw = flag(rest, "--fail-on");
    if (Option.isNone(raw)) return Option.none<EvalFailOn>();
    if (raw.value !== "regression" && raw.value !== "drift") {
      return yield* Effect.fail(`--fail-on takes regression or drift, not ${raw.value}`);
    }
    return Option.some(raw.value);
  });

/** Decode a saved pack report; an unreadable or malformed file is a usage failure. */
const loadBaselineReport = (path: string): Effect.Effect<BaselineReport, string> =>
  Effect.gen(function* loadBaselineReportProgram() {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: () => `cannot read baseline file: ${path}`,
    });
    return yield* decodeBaselineReport(raw).pipe(
      Effect.mapError(() => `invalid baseline report: ${path}`),
    );
  });

const runEval = (rest: ReadonlyArray<string>): Effect.Effect<number, string, CliServices> =>
  Effect.gen(function* runEvalProgram() {
    const fixtures = flag(rest, "--fixtures");
    if (rest[0] !== "pack" || Option.isNone(fixtures)) {
      yield* Effect.sync(() => {
        console.error(EVAL_USAGE);
      });
      return 1;
    }
    const failOn = yield* parseEvalFailOn(rest);
    const baselineFlag = flag(rest, "--baseline");
    if (Option.isSome(failOn) && Option.isNone(baselineFlag)) {
      return yield* Effect.fail("--fail-on needs --baseline FILE");
    }
    const requested = Number.parseInt(flag(rest, "--repeat").pipe(Option.getOrElse(() => "1")), 10);
    const repeat = Number.isNaN(requested) ? 1 : requested;
    const model = Option.getOrUndefined(flag(rest, "--model"));
    const client = yield* JevClient;
    const harness = harnessFromEnv("script");
    // Read the baseline before spending calls: an unreadable or mismatched
    // baseline is a usage error, not a reason to run the pack.
    const baseline = yield* Option.match(baselineFlag, {
      onNone: () => Effect.succeed(Option.none<BaselineReport>()),
      onSome: (path) => loadBaselineReport(path).pipe(Effect.map(Option.some)),
    });
    const report = yield* runPackLab(
      { fixturePath: fixtures.value, repeat, model },
      client.ask,
      harness,
    ).pipe(Effect.mapError((error) => `eval failed: ${error.reason}`));
    if (Option.isSome(baseline) && baseline.value.pack !== report.pack) {
      return yield* Effect.fail(
        `baseline pack ${baseline.value.pack} does not match the current pack ${report.pack}`,
      );
    }
    const comparison = Option.map(baseline, (saved) => compareToBaseline(report, saved));
    yield* Effect.sync(() => {
      if (rest.includes("--json")) {
        console.log(
          JSON.stringify(
            Option.isSome(comparison) ? { report, baseline: comparison.value } : report,
            null,
            2,
          ),
        );
        return;
      }
      printPackLab(report);
      if (Option.isSome(comparison)) printBaselineComparison(comparison.value);
    });
    if (Option.isNone(failOn) || Option.isNone(comparison)) return 0;
    const crossed =
      comparison.value.regressions.length > 0 ||
      (failOn.value === "drift" && comparison.value.drift.length > 0);
    return crossed ? 1 : 0;
  });

/** Claim detection runs in batches of 20 messages, 2 questions each. */
const DETECTION_BATCH = 20;

/** Claims the model routed in `messages`, keyed by message order. */
const detectClaimsInBatches = (
  ask: JevAsk,
  harness: Harness,
  messages: ReadonlyArray<RawMessage>,
  subject: "assistant_message" | "user_prompt",
): Effect.Effect<ReadonlyArray<readonly [number, DetectedClaim]>, string> =>
  Effect.gen(function* detectClaimsInBatchesProgram() {
    const found: Array<readonly [number, DetectedClaim]> = [];
    for (let start = 0; start < messages.length; start += DETECTION_BATCH) {
      const batch = messages.slice(start, start + DETECTION_BATCH);
      const result = yield* ask({
        harness,
        state: {
          messages: batch.map((item, index) => ({ id: `m${index}`, text: item.text })),
        },
        questions: claimDetectionQuestions({ count: batch.length, subject }),
      }).pipe(Effect.mapError(describeJevError));
      for (const claim of detectedClaims(result.answers, batch.length)) {
        found.push([start + claim.index, claim] as const);
      }
    }
    return found;
  });

const detectPromptClaims = (
  ask: JevAsk,
  harness: Harness,
  messages: ReadonlyArray<RawMessage>,
): Effect.Effect<Map<number, string>, string> =>
  detectClaimsInBatches(ask, harness, messages, "user_prompt").pipe(
    Effect.map((found) => {
      const detected = new Map<number, string>();
      for (const [index, claim] of found) detected.set(index, claim.kind);
      return detected;
    }),
  );

const promptExamples = (
  indexes: ReadonlyArray<number>,
  messages: ReadonlyArray<RawMessage>,
  render: (message: RawMessage) => string,
): ReadonlyArray<string> =>
  indexes
    .slice(0, 5)
    .flatMap((index) =>
      Option.toArray(Option.map(Option.fromUndefinedOr(messages[index]), render)),
    );

const detectedExamples = (
  detected: ReadonlyMap<number, string>,
  messages: ReadonlyArray<RawMessage>,
): ReadonlyArray<string> =>
  [...detected.entries()]
    .slice(0, 5)
    .flatMap(([index, kind]) =>
      Option.toArray(
        Option.map(
          Option.fromUndefinedOr(messages[index]),
          (message) => `${kind}: ${message.text.slice(0, 90)}`,
        ),
      ),
    );

const runAuditPrompts = (
  ask: JevAsk,
  harness: Harness,
  rest: ReadonlyArray<string>,
): Effect.Effect<number, string> =>
  Effect.gen(function* runAuditPromptsProgram() {
    const sinceMs = yield* sinceWindowMs(rest, "7d");
    const now = yield* Clock.currentTimeMillis;
    const sinceIso = new Date(now - sinceMs).toISOString();
    const messages = yield* extractOpencode(opencodeDbPath(), sinceIso, "user").pipe(
      Effect.mapError((error) => `audit failed: ${error.source}`),
    );
    const regexTagged = messages.map((message) => matchQuantitativeClaim(message.text).length > 0);
    const detectedIndexes = yield* detectPromptClaims(ask, harness, messages);
    const missed = [...detectedIndexes.keys()].filter((index) => regexTagged[index] !== true);
    const noise = regexTagged.flatMap((tagged, index) =>
      tagged && !detectedIndexes.has(index) ? [index] : [],
    );
    yield* Effect.sync(() => {
      printPromptSummary({
        prompts: messages.length,
        regexTagged: regexTagged.filter(Boolean).length,
        detected: detectedIndexes.size,
        missed: missed.length,
        missedExamples: promptExamples(missed, messages, (message) => message.text.slice(0, 100)),
        detectedExamples: detectedExamples(detectedIndexes, messages),
        noiseExamples: promptExamples(noise, messages, (message) => message.text.slice(0, 100)),
      });
    });
    return 0;
  });

/** A failing harness reader; both audit readers carry the harness tag as `source`. */
type SourceError = AuditError | SessionAuditError;

/** The pi/omp roots to read, in pi-then-omp order. */
type PiOmpRoots = ReadonlyArray<PiOmpRoot>;

type HarnessReaders<A> = {
  readonly opencode: (
    dbPath: string,
    sinceIso: string,
  ) => Effect.Effect<ReadonlyArray<A>, SourceError>;
  readonly claude: (root: string, sinceIso: string) => Effect.Effect<ReadonlyArray<A>, SourceError>;
  readonly piOmp: (
    roots: PiOmpRoots,
    sinceIso: string,
  ) => Effect.Effect<ReadonlyArray<A>, SourceError>;
};

const piOmpRootsFor = (wants: (harness: Harness) => boolean): PiOmpRoots =>
  [
    { harness: "pi" as const, root: piSessionsDir() },
    { harness: "omp" as const, root: ompSessionsDir() },
  ].filter((entry) => wants(entry.harness));

/** Collect what every wanted harness yields, prefixing each failure with `label`. */
const harvestHarnesses = <A>(
  wants: (harness: Harness) => boolean,
  sinceIso: string,
  label: string,
  readers: HarnessReaders<A>,
): Effect.Effect<ReadonlyArray<A>, string> =>
  Effect.gen(function* harvestHarnessesProgram() {
    const fail = (error: SourceError): string => `${label}: ${error.source}`;
    const collected: Array<A> = [];
    if (wants("opencode")) {
      collected.push(
        ...(yield* readers.opencode(opencodeDbPath(), sinceIso).pipe(Effect.mapError(fail))),
      );
    }
    if (wants("claude-code")) {
      collected.push(
        ...(yield* readers.claude(claudeProjectsDir(), sinceIso).pipe(Effect.mapError(fail))),
      );
    }
    const roots = piOmpRootsFor(wants);
    if (roots.length > 0) {
      collected.push(...(yield* readers.piOmp(roots, sinceIso).pipe(Effect.mapError(fail))));
    }
    return collected;
  });

/**
 * Audit reads both opencode surfaces: user turns are the demand signal and
 * assistant turns the published claims. Each keeps its source so compliance
 * can be split.
 */
const auditReaders: HarnessReaders<RawMessage> = {
  opencode: (dbPath, sinceIso) =>
    Effect.gen(function* auditOpencodeProgram() {
      const user = yield* extractOpencode(dbPath, sinceIso, "user");
      const assistant = yield* extractOpencode(dbPath, sinceIso, "assistant");
      return [...user, ...assistant];
    }),
  claude: extractClaude,
  piOmp: extractPiOmp,
};

const digestReaders: HarnessReaders<SessionDigest> = {
  opencode: digestOpencode,
  claude: digestClaude,
  piOmp: digestPiOmp,
};

/** Stage 1: detect claims with Jev, skipping any message that is absent. */
const detectAuditClaims = (
  ask: JevAsk,
  harness: Harness,
  messages: ReadonlyArray<RawMessage>,
): Effect.Effect<ReadonlyArray<DetectedOpportunity>, string> =>
  detectClaimsInBatches(ask, harness, messages, "assistant_message").pipe(
    Effect.map((found) =>
      found.flatMap(([index, claim]) =>
        Option.match(Option.fromUndefinedOr(messages[index]), {
          onNone: (): ReadonlyArray<DetectedOpportunity> => [],
          onSome: (message) => [toDetectedOpportunity(message, claim.kind)],
        }),
      ),
    ),
  );

/** Add one call's question ids to a session's list, keeping order and uniqueness. */
const mergeQuestions = (
  sessionQuestions: Map<string, Array<string>>,
  key: string,
  questions: ReadonlyArray<{ readonly id: string }>,
): void => {
  const list = sessionQuestions.get(key) ?? [];
  for (const question of questions) {
    if (!list.includes(question.id)) list.push(question.id);
  }
  sessionQuestions.set(key, list);
};

const buildSessionQuestions = (
  events: ReadonlyArray<JevEvent>,
  inferredSessions: ReadonlyMap<string, ReadonlyArray<string>>,
): Map<string, Array<string>> => {
  const sessionQuestions = new Map<string, Array<string>>();
  // Inferred sessions are addressed as `harness|indexWithinThatHarness`, using
  // the same log order the attribution pass walked per harness.
  const unattributedCounts = new Map<string, number>();

  /** Sessions a call credits: its own, or every session inference resolved
   * (an issuing subagent session and, when recorded, its parent). */
  const creditsFor = (event: CallEvent): ReadonlyArray<string> => {
    const own = Option.fromUndefinedOr(event.sessionID);
    if (Option.isSome(own)) return [own.value];
    const index = unattributedCounts.get(event.harness) ?? 0;
    unattributedCounts.set(event.harness, index + 1);
    return inferredSessions.get(`${event.harness}|${index}`) ?? [];
  };

  for (const event of events) {
    if (event._tag !== "call") continue;
    for (const sessionID of creditsFor(event)) {
      mergeQuestions(sessionQuestions, `${event.harness}|${sessionID}`, event.questions);
    }
  }
  return sessionQuestions;
};

/**
 * Recover session ids for calls that carry none, per harness that has an
 * offline transcript to read: opencode from its DB, pi/omp from session files.
 * A subagent call also credits the session that spawned it, so a claim written
 * in a parent session can align with questions its subagents asked.
 * Keys are `harness|index` in log order, matching buildSessionQuestions.
 */
const inferCallSessions = (
  events: ReadonlyArray<JevEvent>,
  wants: (harness: Harness) => boolean,
  sinceIso: string,
): Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>, string> =>
  Effect.gen(function* inferCallSessionsProgram() {
    const inferred = new Map<string, ReadonlyArray<string>>();
    const attribute = (harness: Harness, turns: ReadonlyArray<SessionTurn>): void => {
      const calls = events.flatMap((event) =>
        event._tag === "call" && event.harness === harness && event.sessionID === undefined
          ? [
              {
                questionIDs: event.questions.map((question) => question.id),
                atMs: Date.parse(event.ts),
              },
            ]
          : [],
      );
      const parentOf = new Map<string, string>();
      for (const turn of turns) {
        if (turn.parentSessionID !== undefined) {
          parentOf.set(turn.sessionID, turn.parentSessionID);
        }
      }
      attributeCalls(turns, calls).forEach((sessionID, index) => {
        if (Option.isNone(sessionID)) return;
        const parent = parentOf.get(sessionID.value);
        inferred.set(
          `${harness}|${index}`,
          parent === undefined ? [sessionID.value] : [sessionID.value, parent],
        );
      });
    };
    if (wants("opencode")) {
      const turns = yield* loadOpencodeTurns(opencodeDbPath(), sinceIso).pipe(
        Effect.mapError((error) => `audit failed: ${error.source}`),
      );
      attribute("opencode", turns);
    }
    const piOmpRoots = piOmpRootsFor(wants);
    for (const { harness, root } of piOmpRoots) {
      const turns = yield* loadPiOmpTurns([{ harness, root }], sinceIso).pipe(
        Effect.mapError((error) => `audit failed: ${error.source}`),
      );
      attribute(harness, turns);
    }
    return inferred;
  });

/** Stage 2: align each detected claim with the questions asked in its session. */
const correlateAuditClaims = (
  ask: JevAsk,
  harness: Harness,
  detected: ReadonlyArray<DetectedOpportunity>,
  sessionQuestions: ReadonlyMap<string, ReadonlyArray<string>>,
): Effect.Effect<ReadonlyArray<CorrelatedOpportunity>, string> =>
  Effect.gen(function* correlateAuditClaimsProgram() {
    const bySession = new Map<string, Array<DetectedOpportunity>>();
    for (const item of detected) {
      const key = `${item.harness}|${item.sessionID}`;
      const list = bySession.get(key) ?? [];
      list.push(item);
      bySession.set(key, list);
    }
    const correlated: Array<CorrelatedOpportunity> = [];
    for (const [key, items] of bySession) {
      const questions = Option.fromUndefinedOr(sessionQuestions.get(key)).pipe(
        Option.filter((list) => list.length > 0),
      );
      if (Option.isNone(questions)) {
        for (const item of items) correlated.push({ ...item, matched: false });
        continue;
      }
      for (let start = 0; start < items.length; start += 20) {
        const batch = items.slice(start, start + 20);
        const result = yield* ask({
          harness,
          state: {
            sessionQuestions: questions.value.slice(0, 40),
            claims: batch.map((item, index) => ({
              id: `a${index}`,
              pattern: item.pattern,
              excerpt: item.context,
            })),
          },
          questions: claimAlignmentQuestions(
            batch.map((item, index) => ({ id: `a${index}`, excerpt: item.context })),
          ),
        }).pipe(Effect.mapError(describeJevError));
        const matchedIndexes = new Set(alignedIndexes(result.answers, batch.length));
        batch.forEach((item, index) => {
          correlated.push({ ...item, matched: matchedIndexes.has(index) });
        });
      }
    }
    return correlated;
  });

const appendOpportunityEvents = (
  log: EventLogService,
  correlated: ReadonlyArray<CorrelatedOpportunity>,
  now: number,
): Effect.Effect<void, string> =>
  Effect.gen(function* appendOpportunityEventsProgram() {
    for (const opportunity of correlated) {
      yield* log
        .append({
          _tag: "opportunity",
          ts: new Date(now).toISOString(),
          harness: opportunity.harness,
          sessionID: opportunity.sessionID,
          source: opportunity.source,
          pattern: opportunity.pattern,
          matched: opportunity.matched,
          messageTs: opportunity.ts,
        })
        .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
    }
  });

/**
 * Record recovered call→session links so the meter can count which sessions
 * used Jev. One event per harness and session, skipped when the log already
 * has it; a subagent call records the parent session it was credited to as
 * well, matching the alignment rule.
 */
const appendAttributionEvents = (
  log: EventLogService,
  events: ReadonlyArray<JevEvent>,
  inferred: ReadonlyMap<string, ReadonlyArray<string>>,
  now: number,
): Effect.Effect<void, string> =>
  Effect.gen(function* appendAttributionEventsProgram() {
    const recorded = new Set(
      events.flatMap((event) =>
        event._tag === "attribution" ? [`${event.harness}|${event.sessionID}`] : [],
      ),
    );
    const ts = new Date(now).toISOString();
    for (const [key, sessionIDs] of inferred) {
      const separator = key.indexOf("|");
      const harnessTag = separator < 0 ? "" : key.slice(0, separator);
      const harness = Schema.decodeUnknownOption(Harness)(harnessTag);
      if (Option.isNone(harness)) continue;
      for (const sessionID of sessionIDs) {
        const identity = `${harness.value}|${sessionID}`;
        if (recorded.has(identity)) continue;
        recorded.add(identity);
        yield* log
          .append({ _tag: "attribution", ts, harness: harness.value, sessionID })
          .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
      }
    }
  });

const runAudit = (rest: ReadonlyArray<string>): Effect.Effect<number, string, CliServices> =>
  Effect.gen(function* runAuditProgram() {
    const client = yield* JevClient;
    const harness = harnessFromEnv("script");
    if (rest[0] === "prompts") {
      return yield* runAuditPrompts(client.ask, harness, rest);
    }
    if (rest[0] !== "run") {
      yield* Effect.sync(() => {
        console.error(
          "usage: jev audit run [--since 24h] [--harness all|opencode|claude-code|pi|omp] [--dry-run] | jev audit prompts [--since 7d]",
        );
      });
      return 1;
    }
    const log = yield* EventLog;
    const dryRun = rest.includes("--dry-run");
    const selectedHarness = yield* harnessFilterValue(rest, "all");
    const sinceMs = yield* sinceWindowMs(rest, "24h");
    const now = yield* Clock.currentTimeMillis;
    const sinceIso = new Date(now - sinceMs).toISOString();
    const wants = (harness: Harness): boolean =>
      Option.match(selectedHarness, { onNone: () => true, onSome: (only) => only === harness });

    const messages = yield* harvestHarnesses(wants, sinceIso, "audit failed", auditReaders);

    const detected = yield* detectAuditClaims(client.ask, harness, messages);

    // Stage 2: align each detected claim with the questions asked in its session.
    const events = yield* log
      .read()
      .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
    // Calls that did not carry a session id are recovered from the transcript:
    // no harness forwards one over MCP, so matching the call's question ids
    // against the assistant turn that contains them restores the link offline.
    const inferredSessions = yield* inferCallSessions(events, wants, sinceIso);
    const sessionQuestions = buildSessionQuestions(events, inferredSessions);

    const correlated = yield* correlateAuditClaims(client.ask, harness, detected, sessionQuestions);

    if (!dryRun) {
      yield* appendAttributionEvents(log, events, inferredSessions, now);
      yield* appendOpportunityEvents(log, correlated, now);
    }
    yield* Effect.sync(() => {
      printAuditSummary({ messages, correlated }, dryRun);
    });
    return 0;
  });

const runLabel = (rest: ReadonlyArray<string>): Effect.Effect<number, string, CliServices> =>
  Effect.gen(function* runLabelProgram() {
    if (rest[0] !== "sessions") {
      yield* Effect.sync(() => {
        console.error(
          "usage: jev label sessions [--since 24h] [--harness all] [--limit 50] [--dry-run]",
        );
      });
      return 1;
    }
    const sinceMs = yield* sinceWindowMs(rest, "24h");
    const selectedHarness = yield* harnessFilterValue(rest, "all");
    const requested = Number.parseInt(flag(rest, "--limit").pipe(Option.getOrElse(() => "50")), 10);
    const limit = Number.isNaN(requested) ? 50 : requested;
    const dryRun = rest.includes("--dry-run");
    const now = yield* Clock.currentTimeMillis;
    const sinceIso = new Date(now - sinceMs).toISOString();
    const wants = (harness: Harness): boolean =>
      Option.match(selectedHarness, { onNone: () => true, onSome: (only) => only === harness });

    const collected = yield* harvestHarnesses(
      wants,
      sinceIso,
      "session digest failed",
      digestReaders,
    );
    const digests = collected.slice(0, limit);
    if (dryRun) {
      yield* Effect.sync(() => {
        console.log(JSON.stringify({ sessions: digests }, null, 2));
      });
      return 0;
    }

    const client = yield* JevClient;
    const log = yield* EventLog;
    const harness = harnessFromEnv("script");
    const outcomeValues = ["shipped", "blocked", "abandoned", "ongoing"] as const;
    const wasteValues = ["none", "loop", "truncation", "retries", "waiting_on_human"] as const;

    let labeled = 0;
    for (let start = 0; start < digests.length; start += 10) {
      const batch = digests.slice(start, start + 10);
      const result = yield* client
        .ask({ harness, state: { sessions: batch }, questions: labelQuestions(batch) })
        .pipe(Effect.mapError(describeJevError));
      const pickOutcome = (key: string): (typeof outcomeValues)[number] =>
        choiceOf(result.answers, key).pipe(
          Option.flatMap((choice) =>
            Option.fromUndefinedOr(outcomeValues.find((candidate) => candidate === choice.choice)),
          ),
          Option.getOrElse((): (typeof outcomeValues)[number] => "ongoing"),
        );
      const pickWaste = (key: string): (typeof wasteValues)[number] =>
        choiceOf(result.answers, key).pipe(
          Option.flatMap((choice) =>
            Option.fromUndefinedOr(wasteValues.find((candidate) => candidate === choice.choice)),
          ),
          Option.getOrElse((): (typeof wasteValues)[number] => "none"),
        );
      for (let index = 0; index < batch.length; index++) {
        const digest = Option.fromUndefinedOr(batch[index]);
        if (Option.isNone(digest)) continue;
        const taskAnswer = choiceOf(result.answers, `s${index}_task_type`).pipe(
          Option.map((task) => task.choice),
          Option.getOrElse(() => "other"),
        );
        const eventTime = yield* Clock.currentTimeMillis;
        yield* log
          .append({
            _tag: "session_label",
            ts: new Date(eventTime).toISOString(),
            harness: digest.value.harness,
            sessionID: digest.value.sessionID,
            outcome: pickOutcome(`s${index}_outcome`),
            friction: scoreValue(result.answers, `s${index}_friction`),
            waste: pickWaste(`s${index}_waste`),
            taskType: taskAnswer,
            costUsd: digest.value.costUsd,
            tokens: digest.value.tokens,
            toolErrors: digest.value.errorCount,
            stopReasons: digest.value.stopReasons,
            parentSessionID: digest.value.parentSessionID,
          })
          .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
        labeled += 1;
      }
    }
    yield* Effect.sync(() => {
      console.log(`labeled ${labeled} of ${digests.length} candidate sessions`);
    });
    return 0;
  });

const runCheck = (rest: ReadonlyArray<string>): Effect.Effect<number, string, CliServices> =>
  Effect.gen(function* runCheckProgram() {
    if (rest[0] !== "commit") {
      yield* Effect.sync(() => {
        console.error(
          "usage: jev check commit --message-file FILE [--spec FILE] | jev check commit --replay N [--repo DIR] [--spec FILE]",
        );
      });
      return 1;
    }
    const client = yield* JevClient;
    const log = yield* EventLog;
    const harness = harnessFromEnv("script");
    const specFlag = flag(rest, "--spec");
    const rawSpec: Option.Option<string> = yield* Option.match(specFlag, {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (specFile) =>
        Effect.tryPromise({
          try: () => readFile(specFile, "utf8"),
          catch: () => `cannot read spec file: ${specFile}`,
        }).pipe(Effect.map(Option.some)),
    });
    const spec = Option.map(rawSpec, (raw) => clip(stripFencedCode(redact(raw)), 1200));
    // One call per message judging the four rules; with a spec, the same
    // call also answers which rules the repo's spec actually requires.
    const judge = (rawMessage: string): Effect.Effect<CommitVerdict, string> =>
      Effect.gen(function* judgeProgram() {
        const message = clip(stripFencedCode(redact(rawMessage)), 1500);
        const base = { message };
        const state = Option.match(spec, {
          onNone: () => base,
          onSome: (documented) => ({ ...base, spec: documented }),
        });
        const result = yield* client
          .ask({
            harness,
            state,
            questions: commitQuestions({ message, spec: Option.getOrUndefined(spec) }),
          })
          .pipe(Effect.mapError(describeJevError));
        return verdictFor({
          message: rawMessage,
          answers: result.answers,
          profile: Option.getOrUndefined(Option.map(spec, () => result.answers)),
        });
      });
    /** Judge one message and record the verdict; each caller prints it. */
    const judgeAndRecord = (rawMessage: string): Effect.Effect<CommitVerdict, string> =>
      Effect.gen(function* judgeAndRecordProgram() {
        const verdict = yield* judge(rawMessage);
        const now = yield* Clock.currentTimeMillis;
        yield* log
          .append({
            _tag: "triage",
            ts: new Date(now).toISOString(),
            harness,
            feature: "commit",
            summary: { passed: verdict.passed ? 1 : 0, failed: verdict.failed.length },
          })
          .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
        return verdict;
      });
    const replayFlag = flag(rest, "--replay");
    if (Option.isSome(replayFlag)) {
      const requested = Number.parseInt(replayFlag.value, 10);
      const count = Number.isNaN(requested) ? 10 : requested;
      // Trust boundary: repo is operator-controlled cwd for this local-only tool.
      // gitLog uses execFile argv (no shell) and fails closed on bad paths.
      const repo = flag(rest, "--repo").pipe(Option.getOrElse(() => "."));
      const commits = yield* Effect.tryPromise({
        try: () => gitLog(repo, count),
        catch: () => `git log failed in ${repo}`,
      });
      for (const commit of commits) {
        const message = `${commit.subject}\n${commit.body}`;
        const verdict = yield* judgeAndRecord(message);
        yield* Effect.sync(() => {
          const reasons = verdict.failed.length > 0 ? ` failed: ${verdict.failed.join(", ")}` : "";
          console.log(`${commit.hash.slice(0, 8)} pass=${verdict.passed}${reasons}`);
        });
      }
      return 0;
    }
    const messageFile = flag(rest, "--message-file");
    if (Option.isNone(messageFile)) {
      yield* Effect.sync(() => {
        console.error(
          "usage: jev check commit --message-file FILE [--spec FILE] | jev check commit --replay N [--repo DIR] [--spec FILE]",
        );
      });
      return 1;
    }
    const message = yield* Effect.tryPromise({
      try: () => readFile(messageFile.value, "utf8"),
      catch: () => `cannot read message file: ${messageFile.value}`,
    });
    const verdict = yield* judgeAndRecord(message);
    yield* Effect.sync(() => {
      console.log(`pass: ${verdict.passed}`);
      if (verdict.failed.length > 0) console.log(`failed: ${verdict.failed.join(", ")}`);
    });
    return verdict.passed ? 0 : 1;
  });

const MAX_ROUTE_TASK_CHARS = 4_000;

const runRoute = (rest: ReadonlyArray<string>): Effect.Effect<number, string, CliServices> =>
  Effect.gen(function* runRouteProgram() {
    const usage =
      "usage: jev route skills --task TEXT (--skills FILE | --skills-dir DIR) [--dry-run] [--json]";
    if (rest[0] !== "skills") {
      yield* Effect.sync(() => {
        console.error(usage);
      });
      return 1;
    }
    const taskFlag = flag(rest, "--task");
    if (Option.isNone(taskFlag)) {
      yield* Effect.sync(() => {
        console.error(usage);
      });
      return 1;
    }
    const skillsFile = flag(rest, "--skills");
    const skillsDir = flag(rest, "--skills-dir");
    const source = Option.isSome(skillsFile)
      ? { path: skillsFile.value, kind: "file" as const }
      : Option.match(skillsDir, {
          onNone: () => undefined,
          onSome: (path) => ({ path, kind: "dir" as const }),
        });
    if (source === undefined) {
      yield* Effect.sync(() => {
        console.error("route needs one of --skills FILE or --skills-dir DIR");
      });
      return 1;
    }
    const dryRun = rest.includes("--dry-run");
    const asJson = rest.includes("--json");
    const candidates = yield* readSkillCatalog(source.path, source.kind).pipe(
      Effect.mapError((error) => `skill catalog failed: ${error.source}`),
    );
    if (candidates.length === 0) {
      yield* Effect.sync(() => {
        console.error(`no skills found in ${source.path}`);
      });
      return 1;
    }

    const client = yield* JevClient;
    const log = yield* EventLog;
    const harness = harnessFromEnv("cli");
    const input = {
      task: clip(stripFencedCode(redact(taskFlag.value)), MAX_ROUTE_TASK_CHARS),
      candidates,
    };
    const result = yield* client
      .ask({
        harness,
        state: {
          task: input.task,
          skills: candidates.map((candidate) => ({
            name: candidate.name,
            description: candidate.description,
          })),
        },
        questions: skillRouteQuestions(input),
      })
      .pipe(Effect.mapError(describeJevError));
    const route = skillRoute(input, result.answers);
    const followUp = yield* planSkillFollowUp(client.ask, harness, input, route);
    const chain = skillChain(route, followUp.second);
    if (!dryRun) {
      const eventTime = yield* Clock.currentTimeMillis;
      yield* log
        .append({
          _tag: "route",
          ts: new Date(eventTime).toISOString(),
          harness,
          outcome: route._tag === "routed" ? "routed" : "none",
          reason: route._tag === "routed" ? undefined : route.reason,
          skill: route._tag === "routed" ? route.skill : undefined,
          skills: chain.length > 0 ? chain : undefined,
          candidates: candidates.length,
          confidence: route.confidence,
          dependence: route.dependence,
        })
        .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
    }
    yield* Effect.sync(() => {
      const second = followUp.second;
      if (asJson) {
        console.log(
          JSON.stringify({
            decision: route._tag,
            skill: route._tag === "routed" ? route.skill : null,
            skills: chain,
            second: second !== undefined && second._tag === "routed" ? second.skill : null,
            secondReason: second !== undefined && second._tag === "none" ? second.reason : null,
            secondError: followUp.error ?? null,
            reason: route._tag === "routed" ? null : route.reason,
            secondNeeded: route._tag === "routed" ? route.secondNeeded : null,
            confidence: route.confidence,
            dependence: route.dependence,
            candidates: candidates.length,
            model: result.model,
          }),
        );
        return;
      }
      console.log(`jev ${result.model}`);
      console.log(
        route._tag === "routed"
          ? `load: ${chain.join(", then ")}`
          : `load: nothing (${route.reason})`,
      );
      if (second !== undefined && second._tag === "none") {
        console.log(`second: none (${second.reason})`);
      }
      if (followUp.error !== undefined) {
        console.log(`second: unavailable (${describeJevError(followUp.error)})`);
      }
      console.log(`confidence: ${route.confidence}`);
      console.log(`dependence: ${route.dependence}`);
      const totalInput = result.usage.input + (followUp.usage?.input ?? 0);
      const totalOutput = result.usage.output + (followUp.usage?.output ?? 0);
      console.log(`usage: ${totalInput} in / ${totalOutput} out`);
    });
    return 0;
  });

const runTriageReview = (rest: ReadonlyArray<string>): Effect.Effect<number, string, CliServices> =>
  Effect.gen(function* runTriageReviewProgram() {
    const inputFlag = flag(rest, "--input");
    if (Option.isNone(inputFlag)) {
      yield* Effect.sync(() => {
        console.error("usage: jev triage review --input findings.json");
      });
      return 1;
    }
    const client = yield* JevClient;
    const log = yield* EventLog;
    const harness = harnessFromEnv("cli");
    const raw = yield* Effect.tryPromise({
      try: () => readFile(inputFlag.value, "utf8"),
      catch: () => `cannot read findings file: ${inputFlag.value}`,
    });
    const review = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewInput))(raw).pipe(
      Effect.mapError(
        () => "invalid findings JSON: expected { findings: [{ id, title, detail, file?, line? }] }",
      ),
    );
    const findings = review.findings;
    const sanitized = findings.map((finding) => ({
      ...finding,
      title: clip(redact(stripFencedCode(finding.title))),
      detail: clip(redact(stripFencedCode(finding.detail))),
    }));
    const result = yield* client
      .ask({ harness, state: { findings: sanitized }, questions: reviewQuestions(sanitized) })
      .pipe(Effect.mapError(describeJevError));
    const routed = routeTriage(findings, result.answers);
    const now = yield* Clock.currentTimeMillis;
    yield* log
      .append({
        _tag: "triage",
        ts: new Date(now).toISOString(),
        harness,
        feature: "review",
        summary: {
          findings: findings.length,
          blockers: routed.blockers.length,
          cosmetic: routed.cosmetic.length,
          questions: routed.questions.length,
          substantive: routed.reviewSubstantive ? 1 : 0,
          truncated: routed.truncated ? 1 : 0,
        },
      })
      .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
    yield* Effect.sync(() => {
      console.log(JSON.stringify(routed, null, 2));
    });
    return 0;
  });

interface FailureSelection {
  readonly text: string;
  readonly source: string;
}

const transcriptFailureText = (
  ask: JevAsk,
  harness: Harness,
  transcriptPath: string,
): Effect.Effect<Option.Option<string>, string> =>
  Effect.gen(function* transcriptFailureTextProgram() {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(transcriptPath, "utf8"),
      catch: () => `cannot read transcript: ${transcriptPath}`,
    });
    const candidates = transcriptFailureCandidates(raw);
    if (candidates.length === 0) {
      yield* Effect.sync(() => {
        console.error("no failing entry found in the transcript's last 40 lines");
      });
      return Option.none();
    }
    // Transcript snippets can contain raw code or credentials; mask before sending.
    const maskedCandidates = candidates.map((candidate) =>
      clip(stripFencedCode(redact(candidate)), 600),
    );
    if (maskedCandidates.length === 1) return Option.fromUndefinedOr(maskedCandidates[0]);
    const selection = yield* ask({
      harness,
      state: { candidates: maskedCandidates },
      questions: transcriptSelectionQuestions({ candidates: maskedCandidates }),
    }).pipe(Effect.mapError(describeJevError));
    const index = choiceOf(selection.answers, "failure_index").pipe(
      Option.map((answer) => Number.parseInt(answer.choice.replace("candidate_", ""), 10)),
      Option.filter((parsed) => !Number.isNaN(parsed)),
      Option.getOrElse(() => -1),
    );
    const selected = Option.fromUndefinedOr(candidates[index]);
    if (Option.isNone(selected)) {
      yield* Effect.sync(() => {
        console.error("no failing entry selected in the transcript");
      });
      return Option.none();
    }
    return Option.some(selected.value);
  });

const selectFailureText = (
  ask: JevAsk,
  harness: Harness,
  rest: ReadonlyArray<string>,
  stdin: () => Effect.Effect<string, string>,
): Effect.Effect<Option.Option<FailureSelection>, string> =>
  Effect.gen(function* selectFailureTextProgram() {
    const transcriptFlag = flag(rest, "--transcript");
    if (Option.isSome(transcriptFlag)) {
      const text = yield* transcriptFailureText(ask, harness, transcriptFlag.value);
      return Option.map(text, (value): FailureSelection => ({ text: value, source: "transcript" }));
    }
    const textFlag = flag(rest, "--text");
    if (Option.isSome(textFlag) && textFlag.value !== "-") {
      const textPath = textFlag.value;
      const text = yield* Effect.tryPromise({
        try: () => readFile(textPath, "utf8"),
        catch: () => `cannot read failure text: ${textPath}`,
      });
      return Option.some({ text, source: "text" });
    }
    const text = yield* stdin();
    return Option.some({ text, source: "stdin" });
  });

const canonicalFailureFingerprint = (
  ask: JevAsk,
  harness: Harness,
  guard: LoopGuardService,
  failureText: string,
): Effect.Effect<string, string> =>
  Effect.gen(function* canonicalFailureFingerprintProgram() {
    const fp = fingerprint(failureText);
    const safeFailure = clip(stripFencedCode(redact(failureText)));
    const recent = yield* guard
      .recent(5)
      .pipe(Effect.mapError((error) => `loop state ${error.operation} failed`));
    const similar = recent.filter((entry) => entry.fingerprint !== fp);
    if (similar.length === 0) return fp;
    const selection = yield* ask({
      harness,
      state: {
        current: safeFailure.slice(0, 600),
        recent: similar.map((entry) => ({
          fingerprint: entry.fingerprint,
          sample: entry.sample,
        })),
      },
      questions: identityQuestions({ current: safeFailure.slice(0, 600), recent: similar }),
    }).pipe(Effect.mapError(describeJevError));
    const answer = choiceOf(selection.answers, "same_as").pipe(
      Option.map((same) => Number.parseInt(same.choice.replace("recent_", ""), 10)),
      Option.filter((parsed) => !Number.isNaN(parsed)),
      Option.flatMap((parsed) => Option.fromUndefinedOr(similar[parsed])),
    );
    return Option.match(answer, {
      onNone: () => fp,
      onSome: (entry) => entry.fingerprint,
    });
  });

const reportFailure = (
  log: EventLogService,
  harness: Harness,
  canonical: string,
  loop: LoopCheck,
  result: AskResult,
): Effect.Effect<void, string> =>
  Effect.gen(function* reportFailureProgram() {
    const classAnswer = choiceOf(result.answers, "class");
    const blocksAnswer = noulOf(result.answers, "blocks_work");
    const suppressAnswer = noulOf(result.answers, "safe_to_suppress");
    const blocks = noulValue(result.answers, "blocks_work");
    const suppress = noulValue(result.answers, "safe_to_suppress");
    const now = yield* Clock.currentTimeMillis;
    yield* log
      .append({
        _tag: "triage",
        ts: new Date(now).toISOString(),
        harness,
        feature: "failure",
        summary: {
          repeats: loop.count,
          escalate: loop.escalated ? 1 : 0,
          blocks_work: blocks,
          safe_to_suppress: suppress,
        },
      })
      .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
    yield* Effect.sync(() => {
      if (Option.isSome(classAnswer)) {
        console.log(
          `failure class: ${classAnswer.value.choice} (confidence ${classAnswer.value.confidence})`,
        );
      }
      if (Option.isSome(blocksAnswer)) {
        console.log(`blocks_work: p(yes)=${blocksAnswer.value.noul}`);
      }
      if (Option.isSome(suppressAnswer)) {
        console.log(`safe_to_suppress: p(yes)=${suppressAnswer.value.noul}`);
      }
      if (loop.escalated) {
        console.log(
          `ESCALATE: repeated failure (${loop.count}x, fingerprint ${canonical}) — fix the root cause or suppress this session explicitly`,
        );
      }
    });
  });

const runTriageFailure = (
  rest: ReadonlyArray<string>,
  stdin: () => Effect.Effect<string, string>,
): Effect.Effect<number, string, CliServices> =>
  Effect.gen(function* runTriageFailureProgram() {
    const client = yield* JevClient;
    const guard = yield* LoopGuard;
    const log = yield* EventLog;
    const harness = harnessFromEnv("cli");
    const selection = yield* selectFailureText(client.ask, harness, rest, stdin);
    if (Option.isNone(selection)) return 1;
    const canonical = yield* canonicalFailureFingerprint(
      client.ask,
      harness,
      guard,
      selection.value.text,
    );
    const safeFailure = clip(stripFencedCode(redact(selection.value.text)));
    const loop = yield* guard
      .check(canonical, safeFailure.slice(0, 400))
      .pipe(Effect.mapError((error) => `loop state ${error.operation} failed`));
    const result = yield* client
      .ask({
        harness,
        state: {
          source: selection.value.source,
          repeats: loop.count,
          failure: safeFailure,
        },
        questions: failureQuestions({
          text: selection.value.text,
          source: selection.value.source,
          repeats: loop.count,
        }),
      })
      .pipe(Effect.mapError(describeJevError));
    yield* reportFailure(log, harness, canonical, loop, result);
    return 0;
  });

const runTriage = (
  rest: ReadonlyArray<string>,
  stdin: () => Effect.Effect<string, string>,
): Effect.Effect<number, string, CliServices> =>
  Effect.gen(function* runTriageProgram() {
    if (rest[0] === "review") return yield* runTriageReview(rest);
    if (rest[0] !== "failure") {
      yield* Effect.sync(() => {
        console.error(
          "usage: jev triage failure [--text FILE|-] [--transcript FILE] | jev triage review --input findings.json",
        );
      });
      return 1;
    }
    return yield* runTriageFailure(rest, stdin);
  });
const isEntrypoint = Option.fromUndefinedOr(process.argv[1]).pipe(
  Option.exists((entry) => realpathSync(entry) === fileURLToPath(import.meta.url)),
);

if (isEntrypoint) {
  const apiKey = Option.fromUndefinedOr(process.env.TYPESAFE_API_KEY);
  // Production judgments go through the TypeSafe SDK (Jev); the hand-rolled
  // fetch transport remains for tests and offline harnesses.
  const eventLog = EventLogLive(eventsPath());
  const layers = Layer.mergeAll(
    eventLog,
    LoopGuardLive(loopStatePath()),
    JevClientSdkLive({ apiKey, baseURL: sdkBaseURL(apiEndpoint()) }).pipe(Layer.provide(eventLog)),
  );
  const code = await Effect.runPromise(runCli(process.argv.slice(2), layers));
  process.exitCode = code;
}
