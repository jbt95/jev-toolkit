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
  type CorrelatedOpportunity,
  type RawOpportunity,
} from "../audit/opportunities.ts";
import {
  digestClaude,
  digestOpencode,
  digestPiOmp,
  type SessionDigest,
} from "../audit/sessions.ts";
import {
  JevClient,
  JevClientLive,
  createFetchTransport,
  describeJevError,
  formatAnswers,
} from "../core/client.ts";
import { matchQuantitativeClaim } from "../core/detector.ts";
import { PROMPT_DIRECTIVE } from "../core/directives.ts";
import { EventLog, EventLogLive } from "../core/events.ts";
import { LoopGuard, LoopGuardLive, fingerprint } from "../core/loops.ts";
import { serveMeter } from "../core/metrics.ts";
import {
  apiEndpoint,
  claudeProjectsDir,
  eventsPath,
  loopStatePath,
  ompSessionsDir,
  opencodeDbPath,
  piSessionsDir,
} from "../core/paths.ts";
import { Harness, QuestionMap } from "../core/schema.ts";
import { clip, redact } from "../core/text.ts";
import { createMcpDeps, serveMcp } from "../mcp/server.ts";
import { claimAlignmentQuestions, alignedIndexes } from "../question-packs/claim-alignment.ts";
import { claimConfirmQuestions, confirmedIndexes } from "../question-packs/claim-confirmation.ts";
import { commitQuestions, verdictFor } from "../question-packs/commit-conformance.ts";
import { failureQuestions } from "../question-packs/failure-triage.ts";
import { ReviewInput, reviewQuestions, routeTriage } from "../question-packs/reviewer-triage.ts";
import { labelQuestions } from "../question-packs/session-labeling.ts";

const AskPayload = Schema.Struct({
  state: Schema.Json,
  questions: QuestionMap,
  model: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
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
  events   print recent events as JSON lines ([--n N] [--harness <id>])
  audit    scan harness stores for quantitative claims: jev audit run [--since 24h] [--dry-run]
  hook     Claude Code hooks: jev hook prompt
  check    commit conformance: jev check commit --message-file FILE
  label    session labeling: jev label sessions [--since 24h] [--dry-run]
  triage   classify failures or review findings: jev triage failure | review
  mcp      stdio MCP server exposing typesafe_ask (single tool surface)
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

const flag = (argv: ReadonlyArray<string>, name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const parseSinceMs = (value: string): number => {
  const match = /^(\d+)([hd])$/.exec(value);
  if (match === null) return 24 * 60 * 60 * 1000;
  const amount = Number.parseInt(match[1] ?? "24", 10);
  return match[2] === "h" ? amount * 60 * 60 * 1000 : amount * 24 * 60 * 60 * 1000;
};

const printAuditSummary = (
  input: {
    readonly raw: ReadonlyArray<RawOpportunity>;
    readonly correlated: ReadonlyArray<CorrelatedOpportunity>;
  },
  dryRun: boolean,
): void => {
  const perHarness = new Map<string, { raw: number; confirmed: number; matched: number }>();
  const entryFor = (harness: string) => {
    const existing = perHarness.get(harness) ?? { raw: 0, confirmed: 0, matched: 0 };
    perHarness.set(harness, existing);
    return existing;
  };
  for (const item of input.raw) entryFor(item.harness).raw += 1;
  for (const item of input.correlated) {
    const entry = entryFor(item.harness);
    entry.confirmed += 1;
    if (item.matched) entry.matched += 1;
  }
  console.log(
    `harness        candidates confirmed matched missed compliance${dryRun ? " (dry run)" : ""}`,
  );
  const rows = [...perHarness.entries()].sort(([a], [b]) => a.localeCompare(b));
  let rawTotal = 0;
  let confirmedTotal = 0;
  let matchedTotal = 0;
  for (const [harness, counts] of rows) {
    rawTotal += counts.raw;
    confirmedTotal += counts.confirmed;
    matchedTotal += counts.matched;
    const missed = counts.confirmed - counts.matched;
    const compliance =
      counts.confirmed === 0
        ? "0.0%"
        : `${((counts.matched / counts.confirmed) * 100).toFixed(1)}%`;
    console.log(
      `${harness.padEnd(15)}${String(counts.raw).padEnd(11)}${String(counts.confirmed).padEnd(10)}${String(counts.matched).padEnd(8)}${String(missed).padEnd(7)}${compliance}`,
    );
  }
  const kept = rawTotal === 0 ? "0.0%" : `${((confirmedTotal / rawTotal) * 100).toFixed(1)}%`;
  console.log(
    `total: candidates=${rawTotal} confirmed=${confirmedTotal} matched=${matchedTotal} (regex kept ${kept})`,
  );
};

const extractTranscriptFailure = (raw: string): string => {
  const recent = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-40)
    .reverse();
  for (const line of recent) {
    if (line.includes('"is_error":true') || line.includes('"is_error": true')) return line;
  }
  return "";
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
const harnessFromEnv = (fallback: Harness): Harness => {
  const value = process.env.JEV_HARNESS;
  const decoded = value === undefined ? Option.none() : Schema.decodeUnknownOption(Harness)(value);
  return Option.isSome(decoded) ? decoded.value : fallback;
};

export type CliServices = JevClient | EventLog | LoopGuard;

export function runCli(
  argv: ReadonlyArray<string>,
  layers: Layer.Layer<CliServices>,
  stdin: () => Effect.Effect<string, string> = readStdin,
): Effect.Effect<number> {
  const [command, ...rest] = argv;

  const program: Effect.Effect<number, string, CliServices> = Effect.gen(function* () {
    switch (command) {
      case "ask": {
        const client = yield* JevClient;
        const raw = yield* stdin();
        const payload = yield* decodeAskPayload(raw).pipe(
          Effect.mapError(
            () => "invalid ask payload on stdin: expected {state, questions, model?}",
          ),
        );
        const harness = harnessFromEnv("cli");
        const result = yield* client
          .ask({
            harness,
            state: payload.state,
            questions: payload.questions,
            model: payload.model ?? undefined,
          })
          .pipe(Effect.mapError(describeJevError));
        yield* Effect.sync(() => {
          console.log(formatAnswers(result));
        });
        return 0;
      }
      case "events": {
        const log = yield* EventLog;
        const harnessFlag = flag(rest, "--harness");
        const decodedHarness =
          harnessFlag === undefined
            ? Option.none()
            : Schema.decodeUnknownOption(Harness)(harnessFlag);
        const requested = Number.parseInt(flag(rest, "--n") ?? "10", 10);
        const limit = Number.isNaN(requested) ? 10 : requested;
        const events = yield* log
          .read(Option.isSome(decodedHarness) ? { harness: decodedHarness.value } : {})
          .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
        const tail = events.slice(-limit);
        yield* Effect.sync(() => {
          for (const event of tail) console.log(JSON.stringify(event));
        });
        return 0;
      }
      case "audit": {
        if (rest[0] !== "run") {
          yield* Effect.sync(() => {
            console.error(
              "usage: jev audit run [--since 24h] [--harness all|opencode2|claude-code|pi|omp] [--dry-run]",
            );
          });
          return 1;
        }
        const log = yield* EventLog;
        const client = yield* JevClient;
        const harness = harnessFromEnv("script");
        const dryRun = rest.includes("--dry-run");
        const harnessFlag = flag(rest, "--harness") ?? "all";
        const sinceMs = parseSinceMs(flag(rest, "--since") ?? "24h");
        const now = yield* Clock.currentTimeMillis;
        const sinceIso = new Date(now - sinceMs).toISOString();
        const wants = (harness: string): boolean =>
          harnessFlag === "all" || harnessFlag === harness;

        const opportunities: Array<RawOpportunity> = [];
        if (wants("opencode2")) {
          opportunities.push(
            ...(yield* extractOpencode(opencodeDbPath(), sinceIso).pipe(
              Effect.mapError((error) => `audit failed: ${error.source}`),
            )),
          );
        }
        if (wants("claude-code")) {
          opportunities.push(
            ...(yield* extractClaude(claudeProjectsDir(), sinceIso).pipe(
              Effect.mapError((error) => `audit failed: ${error.source}`),
            )),
          );
        }
        const piOmpRoots = [
          { harness: "pi" as const, root: piSessionsDir() },
          { harness: "omp" as const, root: ompSessionsDir() },
        ].filter((entry) => wants(entry.harness));
        if (piOmpRoots.length > 0) {
          opportunities.push(
            ...(yield* extractPiOmp(piOmpRoots, sinceIso).pipe(
              Effect.mapError((error) => `audit failed: ${error.source}`),
            )),
          );
        }

        // Stage 1: confirm regex candidates with Jev (batches of 20).
        const confirmed: Array<RawOpportunity> = [];
        for (let start = 0; start < opportunities.length; start += 20) {
          const batch = opportunities.slice(start, start + 20);
          const result = yield* client
            .ask({
              harness,
              state: {
                candidates: batch.map((item, index) => ({
                  id: `c${index}`,
                  pattern: item.pattern,
                  matchedText: item.matchedText,
                  context: item.context,
                })),
              },
              questions: claimConfirmQuestions(
                batch.map((item, index) => ({ id: `c${index}`, matchedText: item.matchedText })),
              ),
            })
            .pipe(Effect.mapError(describeJevError));
          const kept = confirmedIndexes(result.answers, batch.length);
          for (const index of kept) {
            const item = batch[index];
            if (item !== undefined) confirmed.push(item);
          }
        }

        // Stage 2: align each confirmed claim with the questions asked in its session.
        const events = yield* log
          .read()
          .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
        const sessionQuestions = new Map<string, Array<string>>();
        for (const event of events) {
          if (event._tag === "call" && event.sessionID !== undefined) {
            const key = `${event.harness}|${event.sessionID}`;
            const list = sessionQuestions.get(key) ?? [];
            for (const question of event.questions) {
              if (!list.includes(question.id)) list.push(question.id);
            }
            sessionQuestions.set(key, list);
          }
        }
        const bySession = new Map<string, Array<RawOpportunity>>();
        for (const item of confirmed) {
          const key = `${item.harness}|${item.sessionID}`;
          const list = bySession.get(key) ?? [];
          list.push(item);
          bySession.set(key, list);
        }
        const correlated: Array<CorrelatedOpportunity> = [];
        for (const [key, items] of bySession) {
          const questions = sessionQuestions.get(key);
          if (questions === undefined || questions.length === 0) {
            for (const item of items) correlated.push({ ...item, matched: false });
            continue;
          }
          for (let start = 0; start < items.length; start += 20) {
            const batch = items.slice(start, start + 20);
            const result = yield* client
              .ask({
                harness,
                state: {
                  sessionQuestions: questions.slice(0, 40),
                  claims: batch.map((item, index) => ({
                    id: `a${index}`,
                    pattern: item.pattern,
                    matchedText: item.matchedText,
                    context: item.context,
                  })),
                },
                questions: claimAlignmentQuestions(
                  batch.map((item, index) => ({ id: `a${index}`, matchedText: item.matchedText })),
                ),
              })
              .pipe(Effect.mapError(describeJevError));
            const matchedIndexes = new Set(alignedIndexes(result.answers, batch.length));
            batch.forEach((item, index) => {
              correlated.push({ ...item, matched: matchedIndexes.has(index) });
            });
          }
        }

        if (!dryRun) {
          for (const opportunity of correlated) {
            yield* log
              .append({
                _tag: "opportunity",
                ts: new Date(now).toISOString(),
                harness: opportunity.harness,
                sessionID: opportunity.sessionID,
                source: "assistant_message",
                pattern: opportunity.pattern,
                matched: opportunity.matched,
              })
              .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
          }
        }
        yield* Effect.sync(() => {
          printAuditSummary({ raw: opportunities, correlated }, dryRun);
        });
        return 0;
      }
      case "label": {
        if (rest[0] !== "sessions") {
          yield* Effect.sync(() => {
            console.error(
              "usage: jev label sessions [--since 24h] [--harness all] [--limit 50] [--dry-run]",
            );
          });
          return 1;
        }
        const sinceMs = parseSinceMs(flag(rest, "--since") ?? "24h");
        const harnessFlag = flag(rest, "--harness") ?? "all";
        const requested = Number.parseInt(flag(rest, "--limit") ?? "50", 10);
        const limit = Number.isNaN(requested) ? 50 : requested;
        const dryRun = rest.includes("--dry-run");
        const now = yield* Clock.currentTimeMillis;
        const sinceIso = new Date(now - sinceMs).toISOString();
        const wants = (harness: string): boolean =>
          harnessFlag === "all" || harnessFlag === harness;

        const collected: Array<SessionDigest> = [];
        if (wants("opencode2")) {
          collected.push(
            ...(yield* digestOpencode(opencodeDbPath(), sinceIso).pipe(
              Effect.mapError((error) => `session digest failed: ${error.source}`),
            )),
          );
        }
        if (wants("claude-code")) {
          collected.push(
            ...(yield* digestClaude(claudeProjectsDir(), sinceIso).pipe(
              Effect.mapError((error) => `session digest failed: ${error.source}`),
            )),
          );
        }
        const piOmpRoots = [
          { harness: "pi" as const, root: piSessionsDir() },
          { harness: "omp" as const, root: ompSessionsDir() },
        ].filter((entry) => wants(entry.harness));
        if (piOmpRoots.length > 0) {
          collected.push(
            ...(yield* digestPiOmp(piOmpRoots, sinceIso).pipe(
              Effect.mapError((error) => `session digest failed: ${error.source}`),
            )),
          );
        }
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
        const pickOutcome = (value: string | undefined): (typeof outcomeValues)[number] =>
          outcomeValues.find((candidate) => candidate === value) ?? "ongoing";
        const pickWaste = (value: string | undefined): (typeof wasteValues)[number] =>
          wasteValues.find((candidate) => candidate === value) ?? "none";

        let labeled = 0;
        for (let start = 0; start < digests.length; start += 10) {
          const batch = digests.slice(start, start + 10);
          const result = yield* client
            .ask({ harness, state: { sessions: batch }, questions: labelQuestions(batch) })
            .pipe(Effect.mapError(describeJevError));
          for (let index = 0; index < batch.length; index++) {
            const digest = batch[index];
            if (digest === undefined) continue;
            const outcomeAnswer = result.answers[`s${index}_outcome`];
            const frictionAnswer = result.answers[`s${index}_friction`];
            const wasteAnswer = result.answers[`s${index}_waste`];
            const taskAnswer = result.answers["task_type"];
            const eventTime = yield* Clock.currentTimeMillis;
            yield* log
              .append({
                _tag: "session_label",
                ts: new Date(eventTime).toISOString(),
                harness: digest.harness,
                sessionID: digest.sessionID,
                outcome: pickOutcome(
                  outcomeAnswer?._tag === "choice" ? outcomeAnswer.choice : undefined,
                ),
                friction: frictionAnswer?._tag === "score" ? frictionAnswer.score : 0,
                waste: pickWaste(wasteAnswer?._tag === "choice" ? wasteAnswer.choice : undefined),
                taskType: taskAnswer?._tag === "choice" ? taskAnswer.choice : "other",
              })
              .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
            labeled += 1;
          }
        }
        yield* Effect.sync(() => {
          console.log(`labeled ${labeled} of ${digests.length} candidate sessions`);
        });
        return 0;
      }
      case "check": {
        if (rest[0] !== "commit") {
          yield* Effect.sync(() => {
            console.error(
              "usage: jev check commit --message-file FILE | jev check commit --replay N [--repo DIR]",
            );
          });
          return 1;
        }
        const client = yield* JevClient;
        const log = yield* EventLog;
        const harness = harnessFromEnv("script");
        const replayFlag = flag(rest, "--replay");
        if (replayFlag !== undefined) {
          const requested = Number.parseInt(replayFlag, 10);
          const count = Number.isNaN(requested) ? 10 : requested;
          const repo = flag(rest, "--repo") ?? ".";
          const commits = yield* Effect.tryPromise({
            try: () => gitLog(repo, count),
            catch: () => `git log failed in ${repo}`,
          });
          for (const commit of commits) {
            const message = `${commit.subject}\n${commit.body}`;
            const result = yield* client
              .ask({ harness, state: { message }, questions: commitQuestions({ message }) })
              .pipe(Effect.mapError(describeJevError));
            const verdict = verdictFor({ message, answers: result.answers });
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
            yield* Effect.sync(() => {
              const reasons =
                verdict.failed.length > 0 ? ` failed: ${verdict.failed.join(", ")}` : "";
              console.log(`${commit.hash.slice(0, 8)} pass=${verdict.passed}${reasons}`);
            });
          }
          return 0;
        }
        const messageFile = flag(rest, "--message-file");
        if (messageFile === undefined) {
          yield* Effect.sync(() => {
            console.error(
              "usage: jev check commit --message-file FILE | jev check commit --replay N [--repo DIR]",
            );
          });
          return 1;
        }
        const message = yield* Effect.tryPromise({
          try: () => readFile(messageFile, "utf8"),
          catch: () => `cannot read message file: ${messageFile}`,
        });
        const result = yield* client
          .ask({ harness, state: { message }, questions: commitQuestions({ message }) })
          .pipe(Effect.mapError(describeJevError));
        const verdict = verdictFor({ message, answers: result.answers });
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
        yield* Effect.sync(() => {
          console.log(`pass: ${verdict.passed}`);
          if (verdict.failed.length > 0) console.log(`failed: ${verdict.failed.join(", ")}`);
        });
        return verdict.passed ? 0 : 1;
      }
      case "triage": {
        if (rest[0] === "review") {
          const inputFlag = flag(rest, "--input");
          if (inputFlag === undefined) {
            yield* Effect.sync(() => {
              console.error("usage: jev triage review --input findings.json");
            });
            return 1;
          }
          const client = yield* JevClient;
          const log = yield* EventLog;
          const harness = harnessFromEnv("cli");
          const raw = yield* Effect.tryPromise({
            try: () => readFile(inputFlag, "utf8"),
            catch: () => `cannot read findings file: ${inputFlag}`,
          });
          const review = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewInput))(
            raw,
          ).pipe(
            Effect.mapError(
              () =>
                "invalid findings JSON: expected { findings: [{ id, title, detail, file?, line? }] }",
            ),
          );
          const findings = review.findings;
          const sanitized = findings.map((finding) => ({
            ...finding,
            detail: clip(redact(finding.detail)),
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
        }
        if (rest[0] !== "failure") {
          yield* Effect.sync(() => {
            console.error(
              "usage: jev triage failure [--text FILE|-] [--transcript FILE] | jev triage review --input findings.json",
            );
          });
          return 1;
        }
        const client = yield* JevClient;
        const guard = yield* LoopGuard;
        const log = yield* EventLog;
        const harness = harnessFromEnv("cli");
        const textFlag = flag(rest, "--text");
        const transcriptFlag = flag(rest, "--transcript");
        let failureText: string;
        let source: string;
        if (transcriptFlag !== undefined) {
          const raw = yield* Effect.tryPromise({
            try: () => readFile(transcriptFlag, "utf8"),
            catch: () => `cannot read transcript: ${transcriptFlag}`,
          });
          failureText = extractTranscriptFailure(raw);
          if (failureText.length === 0) {
            yield* Effect.sync(() => {
              console.error("no failing entry found in the transcript's last 40 lines");
            });
            return 1;
          }
          source = "transcript";
        } else if (textFlag !== undefined && textFlag !== "-") {
          failureText = yield* Effect.tryPromise({
            try: () => readFile(textFlag, "utf8"),
            catch: () => `cannot read failure text: ${textFlag}`,
          });
          source = "text";
        } else {
          failureText = yield* stdin();
          source = "stdin";
        }

        const fp = fingerprint(failureText);
        const loop = yield* guard
          .check(fp)
          .pipe(Effect.mapError((error) => `loop state ${error.operation} failed`));
        const result = yield* client
          .ask({
            harness,
            state: { source, repeats: loop.count, failure: clip(redact(failureText)) },
            questions: failureQuestions({ text: failureText, source, repeats: loop.count }),
          })
          .pipe(Effect.mapError(describeJevError));

        const classAnswer = result.answers["class"];
        const blocksAnswer = result.answers["blocks_work"];
        const suppressAnswer = result.answers["safe_to_suppress"];
        const blocks = blocksAnswer?._tag === "noul" ? blocksAnswer.noul : 0;
        const suppress = suppressAnswer?._tag === "noul" ? suppressAnswer.noul : 0;
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
          if (classAnswer?._tag === "choice") {
            console.log(
              `failure class: ${classAnswer.choice} (confidence ${classAnswer.confidence})`,
            );
          }
          if (blocksAnswer?._tag === "noul")
            console.log(`blocks_work: p(yes)=${blocksAnswer.noul}`);
          if (suppressAnswer?._tag === "noul") {
            console.log(`safe_to_suppress: p(yes)=${suppressAnswer.noul}`);
          }
          if (loop.escalated) {
            console.log(
              `ESCALATE: repeated failure (${loop.count}x, fingerprint ${fp}) — fix the root cause or suppress this session explicitly`,
            );
          }
        });
        return 0;
      }
      case "hook": {
        if (rest[0] !== "prompt") {
          yield* Effect.sync(() => {
            console.error("usage: jev hook prompt");
          });
          return 1;
        }
        const raw = yield* stdin();
        const decoded = decodeHookInput(raw);
        if (Option.isSome(decoded)) {
          const hits = matchQuantitativeClaim(decoded.value.prompt);
          if (hits.length > 0) {
            yield* Effect.sync(() => {
              console.log(PROMPT_DIRECTIVE);
            });
          }
        }
        return 0;
      }
      case "mcp": {
        const client = yield* JevClient;
        const harness = harnessFromEnv("script");
        yield* Effect.tryPromise({
          try: () => serveMcp(createMcpDeps(harness, client.ask)),
          catch: () => "mcp server failed",
        });
        return 0;
      }
      case "meter": {
        if (rest[0] !== "serve") {
          yield* Effect.sync(() => {
            console.error("usage: jev meter serve [--port N]");
          });
          return 1;
        }
        const log = yield* EventLog;
        const portFlag = flag(rest, "--port") ?? process.env.JEV_METER_PORT;
        const requestedPort = portFlag === undefined ? 8788 : Number.parseInt(portFlag, 10);
        const port = Number.isNaN(requestedPort) ? 8788 : requestedPort;
        return yield* serveMeter(port, log).pipe(
          Effect.mapError(() => "meter failed to start (port in use?)"),
        );
      }
      default: {
        yield* Effect.sync(() => {
          console.error(USAGE);
        });
        return 1;
      }
    }
  });

  return Effect.gen(function* () {
    const outcome = yield* Effect.result(program);
    if (outcome._tag === "Success") return outcome.success;
    yield* Effect.sync(() => {
      console.error(outcome.failure);
    });
    return 1;
  }).pipe(Effect.provide(layers));
}

const isEntrypoint =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const keyFromEnv = process.env.TYPESAFE_API_KEY;
  const apiKey = keyFromEnv === undefined ? Option.none() : Option.some(keyFromEnv);
  // The transport is only reached when a key exists; the client rejects earlier otherwise.
  const transport = createFetchTransport(apiEndpoint(), keyFromEnv ?? "");
  const eventLog = EventLogLive(eventsPath());
  const layers = Layer.mergeAll(
    eventLog,
    LoopGuardLive(loopStatePath()),
    JevClientLive({ apiKey, transport }).pipe(Layer.provide(eventLog)),
  );
  const code = await Effect.runPromise(runCli(process.argv.slice(2), layers));
  process.exitCode = code;
}
