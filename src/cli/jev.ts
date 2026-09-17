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
  type CorrelatedOpportunity,
  type DetectedOpportunity,
  type RawMessage,
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
import { Harness, QuestionMap, type Answer } from "../core/schema.ts";
import { clip, redact, stripFencedCode } from "../core/text.ts";
import { transcriptFailureCandidates } from "../core/transcript.ts";
import { createMcpDeps, serveMcp } from "../mcp/server.ts";
import { claimAlignmentQuestions, alignedIndexes } from "../question-packs/claim-alignment.ts";
import { claimDetectionQuestions, detectedClaims } from "../question-packs/claim-detection.ts";
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

const flag = (argv: ReadonlyArray<string>, name: string): Option.Option<string> => {
  const index = argv.indexOf(name);
  if (index === -1) return Option.none();
  return Option.fromUndefinedOr(argv[index + 1]);
};

const parseSinceMs = (value: string): number => {
  const match = /^(\d+)([hd])$/.exec(value);
  if (match === null) return 24 * 60 * 60 * 1000;
  const amount = Number.parseInt(match[1] ?? "24", 10);
  return match[2] === "h" ? amount * 60 * 60 * 1000 : amount * 24 * 60 * 60 * 1000;
};

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
            model: Option.getOrUndefined(Option.fromNullishOr(payload.model)),
          })
          .pipe(Effect.mapError(describeJevError));
        yield* Effect.sync(() => {
          console.log(formatAnswers(result));
        });
        return 0;
      }
      case "events": {
        const log = yield* EventLog;
        const decodedHarness = Option.flatMap(flag(rest, "--harness"), (harnessFlag) =>
          Schema.decodeUnknownOption(Harness)(harnessFlag),
        );
        const requested = Number.parseInt(flag(rest, "--n").pipe(Option.getOrElse(() => "10")), 10);
        const limit = Number.isNaN(requested) ? 10 : requested;
        const events = yield* log
          .read({ harness: Option.getOrUndefined(decodedHarness) })
          .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
        const tail = events.slice(-limit);
        yield* Effect.sync(() => {
          for (const event of tail) console.log(JSON.stringify(event));
        });
        return 0;
      }
      case "audit": {
        const client = yield* JevClient;
        const harness = harnessFromEnv("script");
        if (rest[0] === "prompts") {
          const sinceMs = parseSinceMs(flag(rest, "--since").pipe(Option.getOrElse(() => "7d")));
          const now = yield* Clock.currentTimeMillis;
          const sinceIso = new Date(now - sinceMs).toISOString();
          const messages = yield* extractOpencode(opencodeDbPath(), sinceIso, "user").pipe(
            Effect.mapError((error) => `audit failed: ${error.source}`),
          );
          const regexTagged = messages.map(
            (message) => matchQuantitativeClaim(message.text).length > 0,
          );
          const detectedIndexes = new Map<number, string>();
          for (let start = 0; start < messages.length; start += 20) {
            const batch = messages.slice(start, start + 20);
            const result = yield* client
              .ask({
                harness,
                state: {
                  messages: batch.map((item, index) => ({ id: `m${index}`, text: item.text })),
                },
                questions: claimDetectionQuestions({
                  count: batch.length,
                  subject: "user_prompt",
                }),
              })
              .pipe(Effect.mapError(describeJevError));
            for (const found of detectedClaims(result.answers, batch.length)) {
              detectedIndexes.set(start + found.index, found.kind);
            }
          }
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
              missedExamples: missed
                .slice(0, 5)
                .flatMap((index) =>
                  Option.toArray(
                    Option.map(Option.fromUndefinedOr(messages[index]), (message) =>
                      message.text.slice(0, 100),
                    ),
                  ),
                ),
              detectedExamples: [...detectedIndexes.entries()]
                .slice(0, 5)
                .flatMap(([index, kind]) =>
                  Option.toArray(
                    Option.map(
                      Option.fromUndefinedOr(messages[index]),
                      (message) => `${kind}: ${message.text.slice(0, 90)}`,
                    ),
                  ),
                ),
              noiseExamples: noise
                .slice(0, 5)
                .flatMap((index) =>
                  Option.toArray(
                    Option.map(Option.fromUndefinedOr(messages[index]), (message) =>
                      message.text.slice(0, 100),
                    ),
                  ),
                ),
            });
          });
          return 0;
        }
        if (rest[0] !== "run") {
          yield* Effect.sync(() => {
            console.error(
              "usage: jev audit run [--since 24h] [--harness all|opencode2|claude-code|pi|omp] [--dry-run] | jev audit prompts [--since 7d]",
            );
          });
          return 1;
        }
        const log = yield* EventLog;
        const dryRun = rest.includes("--dry-run");
        const harnessFlag = flag(rest, "--harness").pipe(Option.getOrElse(() => "all"));
        const sinceMs = parseSinceMs(flag(rest, "--since").pipe(Option.getOrElse(() => "24h")));
        const now = yield* Clock.currentTimeMillis;
        const sinceIso = new Date(now - sinceMs).toISOString();
        const wants = (harness: string): boolean =>
          harnessFlag === "all" || harnessFlag === harness;

        const messages: Array<RawMessage> = [];
        if (wants("opencode2")) {
          messages.push(
            ...(yield* extractOpencode(opencodeDbPath(), sinceIso, "assistant").pipe(
              Effect.mapError((error) => `audit failed: ${error.source}`),
            )),
          );
        }
        if (wants("claude-code")) {
          messages.push(
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
          messages.push(
            ...(yield* extractPiOmp(piOmpRoots, sinceIso).pipe(
              Effect.mapError((error) => `audit failed: ${error.source}`),
            )),
          );
        }

        // Stage 1: detect claims with Jev (batches of 20 messages, 2 questions each).
        const detected: Array<DetectedOpportunity> = [];
        for (let start = 0; start < messages.length; start += 20) {
          const batch = messages.slice(start, start + 20);
          const result = yield* client
            .ask({
              harness,
              state: {
                messages: batch.map((item, index) => ({ id: `m${index}`, text: item.text })),
              },
              questions: claimDetectionQuestions({
                count: batch.length,
                subject: "assistant_message",
              }),
            })
            .pipe(Effect.mapError(describeJevError));
          for (const found of detectedClaims(result.answers, batch.length)) {
            const message = Option.fromUndefinedOr(batch[found.index]);
            if (Option.isSome(message))
              detected.push(toDetectedOpportunity(message.value, found.kind));
          }
        }

        // Stage 2: align each detected claim with the questions asked in its session.
        const events = yield* log
          .read()
          .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
        const sessionQuestions = new Map<string, Array<string>>();
        for (const event of events) {
          if (event._tag === "call") {
            const sessionID = Option.fromUndefinedOr(event.sessionID);
            if (Option.isNone(sessionID)) continue;
            const key = `${event.harness}|${sessionID.value}`;
            const list = sessionQuestions.get(key) ?? [];
            for (const question of event.questions) {
              if (!list.includes(question.id)) list.push(question.id);
            }
            sessionQuestions.set(key, list);
          }
        }
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
            const result = yield* client
              .ask({
                harness,
                state: {
                  sessionQuestions: questions.value.slice(0, 40),
                  claims: batch.map((item, index) => ({
                    id: `a${index}`,
                    pattern: item.pattern,
                    excerpt: item.excerpt,
                  })),
                },
                questions: claimAlignmentQuestions(
                  batch.map((item, index) => ({ id: `a${index}`, excerpt: item.excerpt })),
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
          printAuditSummary({ messages, correlated }, dryRun);
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
        const sinceMs = parseSinceMs(flag(rest, "--since").pipe(Option.getOrElse(() => "24h")));
        const harnessFlag = flag(rest, "--harness").pipe(Option.getOrElse(() => "all"));
        const requested = Number.parseInt(
          flag(rest, "--limit").pipe(Option.getOrElse(() => "50")),
          10,
        );
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
        const pickOutcome = (answer: Answer | undefined): (typeof outcomeValues)[number] =>
          Option.fromUndefinedOr(answer).pipe(
            Option.filter(
              (choice): choice is Extract<Answer, { readonly _tag: "choice" }> =>
                choice._tag === "choice",
            ),
            Option.flatMap((choice) =>
              Option.fromUndefinedOr(
                outcomeValues.find((candidate) => candidate === choice.choice),
              ),
            ),
            Option.getOrElse((): (typeof outcomeValues)[number] => "ongoing"),
          );
        const pickWaste = (answer: Answer | undefined): (typeof wasteValues)[number] =>
          Option.fromUndefinedOr(answer).pipe(
            Option.filter(
              (choice): choice is Extract<Answer, { readonly _tag: "choice" }> =>
                choice._tag === "choice",
            ),
            Option.flatMap((choice) =>
              Option.fromUndefinedOr(wasteValues.find((candidate) => candidate === choice.choice)),
            ),
            Option.getOrElse((): (typeof wasteValues)[number] => "none"),
          );
        const scoreOrZero = (answer: Answer | undefined): number =>
          Option.fromUndefinedOr(answer).pipe(
            Option.filter(
              (score): score is Extract<Answer, { readonly _tag: "score" }> =>
                score._tag === "score",
            ),
            Option.map((score) => score.score),
            Option.getOrElse(() => 0),
          );

        let labeled = 0;
        for (let start = 0; start < digests.length; start += 10) {
          const batch = digests.slice(start, start + 10);
          const result = yield* client
            .ask({ harness, state: { sessions: batch }, questions: labelQuestions(batch) })
            .pipe(Effect.mapError(describeJevError));
          for (let index = 0; index < batch.length; index++) {
            const digest = Option.fromUndefinedOr(batch[index]);
            if (Option.isNone(digest)) continue;
            const outcomeAnswer = result.answers[`s${index}_outcome`];
            const frictionAnswer = result.answers[`s${index}_friction`];
            const wasteAnswer = result.answers[`s${index}_waste`];
            const taskAnswer = Option.fromUndefinedOr(result.answers[`s${index}_task_type`]).pipe(
              Option.filter(
                (task): task is Extract<Answer, { readonly _tag: "choice" }> =>
                  task._tag === "choice",
              ),
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
                outcome: pickOutcome(outcomeAnswer),
                friction: scoreOrZero(frictionAnswer),
                waste: pickWaste(wasteAnswer),
                taskType: taskAnswer,
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
          Effect.gen(function* () {
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
        const replayFlag = flag(rest, "--replay");
        if (Option.isSome(replayFlag)) {
          const requested = Number.parseInt(replayFlag.value, 10);
          const count = Number.isNaN(requested) ? 10 : requested;
          const repo = flag(rest, "--repo").pipe(Option.getOrElse(() => "."));
          const commits = yield* Effect.tryPromise({
            try: () => gitLog(repo, count),
            catch: () => `git log failed in ${repo}`,
          });
          for (const commit of commits) {
            const message = `${commit.subject}\n${commit.body}`;
            const verdict = yield* judge(message);
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
        const verdict = yield* judge(message);
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
        if (Option.isSome(transcriptFlag)) {
          const transcriptPath = transcriptFlag.value;
          const raw = yield* Effect.tryPromise({
            try: () => readFile(transcriptPath, "utf8"),
            catch: () => `cannot read transcript: ${transcriptPath}`,
          });
          const candidates = transcriptFailureCandidates(raw);
          if (candidates.length === 0) {
            yield* Effect.sync(() => {
              console.error("no failing entry found in the transcript's last 40 lines");
            });
            return 1;
          }
          // Transcript snippets can contain raw code or credentials; mask before sending.
          const maskedCandidates = candidates.map((candidate) =>
            clip(stripFencedCode(redact(candidate)), 600),
          );
          if (maskedCandidates.length === 1) {
            failureText = Option.fromUndefinedOr(maskedCandidates[0]).pipe(
              Option.getOrElse(() => ""),
            );
          } else {
            const selection = yield* client
              .ask({
                harness,
                state: { candidates: maskedCandidates },
                questions: transcriptSelectionQuestions({ candidates: maskedCandidates }),
              })
              .pipe(Effect.mapError(describeJevError));
            const index = Option.fromUndefinedOr(selection.answers["failure_index"]).pipe(
              Option.filter(
                (answer): answer is Extract<Answer, { readonly _tag: "choice" }> =>
                  answer._tag === "choice",
              ),
              Option.map((answer) => Number.parseInt(answer.choice.replace("candidate_", ""), 10)),
              Option.filter((parsed) => !Number.isNaN(parsed)),
              Option.getOrElse(() => -1),
            );
            const selected = Option.fromUndefinedOr(candidates[index]);
            if (Option.isNone(selected)) {
              yield* Effect.sync(() => {
                console.error("no failing entry selected in the transcript");
              });
              return 1;
            }
            failureText = selected.value;
          }
          source = "transcript";
        } else if (Option.isSome(textFlag) && textFlag.value !== "-") {
          const textPath = textFlag.value;
          failureText = yield* Effect.tryPromise({
            try: () => readFile(textPath, "utf8"),
            catch: () => `cannot read failure text: ${textPath}`,
          });
          source = "text";
        } else {
          failureText = yield* stdin();
          source = "stdin";
        }

        const fp = fingerprint(failureText);
        const safeFailure = clip(stripFencedCode(redact(failureText)));
        const recent = yield* guard
          .recent(5)
          .pipe(Effect.mapError((error) => `loop state ${error.operation} failed`));
        const similar = recent.filter((entry) => entry.fingerprint !== fp);
        let canonical = fp;
        if (similar.length > 0) {
          const selection = yield* client
            .ask({
              harness,
              state: {
                current: safeFailure.slice(0, 600),
                recent: similar.map((entry) => ({
                  fingerprint: entry.fingerprint,
                  sample: entry.sample,
                })),
              },
              questions: identityQuestions({ current: safeFailure.slice(0, 600), recent: similar }),
            })
            .pipe(Effect.mapError(describeJevError));
          const answer = Option.fromUndefinedOr(selection.answers["same_as"]).pipe(
            Option.filter(
              (same): same is Extract<Answer, { readonly _tag: "choice" }> =>
                same._tag === "choice",
            ),
            Option.map((same) => Number.parseInt(same.choice.replace("recent_", ""), 10)),
            Option.filter((parsed) => !Number.isNaN(parsed)),
            Option.flatMap((parsed) => Option.fromUndefinedOr(similar[parsed])),
          );
          if (Option.isSome(answer)) canonical = answer.value.fingerprint;
        }
        const loop = yield* guard
          .check(canonical, safeFailure.slice(0, 400))
          .pipe(Effect.mapError((error) => `loop state ${error.operation} failed`));
        const result = yield* client
          .ask({
            harness,
            state: {
              source,
              repeats: loop.count,
              failure: clip(stripFencedCode(redact(failureText))),
            },
            questions: failureQuestions({ text: failureText, source, repeats: loop.count }),
          })
          .pipe(Effect.mapError(describeJevError));

        const classAnswer = Option.fromUndefinedOr(result.answers["class"]).pipe(
          Option.filter(
            (classified): classified is Extract<Answer, { readonly _tag: "choice" }> =>
              classified._tag === "choice",
          ),
        );
        const blocksAnswer = Option.fromUndefinedOr(result.answers["blocks_work"]).pipe(
          Option.filter(
            (blocks): blocks is Extract<Answer, { readonly _tag: "noul" }> =>
              blocks._tag === "noul",
          ),
        );
        const suppressAnswer = Option.fromUndefinedOr(result.answers["safe_to_suppress"]).pipe(
          Option.filter(
            (suppress): suppress is Extract<Answer, { readonly _tag: "noul" }> =>
              suppress._tag === "noul",
          ),
        );
        const blocks = Option.map(blocksAnswer, (answer) => answer.noul).pipe(
          Option.getOrElse(() => 0),
        );
        const suppress = Option.map(suppressAnswer, (answer) => answer.noul).pipe(
          Option.getOrElse(() => 0),
        );
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
          if (Option.isSome(blocksAnswer))
            console.log(`blocks_work: p(yes)=${blocksAnswer.value.noul}`);
          if (Option.isSome(suppressAnswer)) {
            console.log(`safe_to_suppress: p(yes)=${suppressAnswer.value.noul}`);
          }
          if (loop.escalated) {
            console.log(
              `ESCALATE: repeated failure (${loop.count}x, fingerprint ${canonical}) — fix the root cause or suppress this session explicitly`,
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

const isEntrypoint = Option.fromUndefinedOr(process.argv[1]).pipe(
  Option.exists((entry) => realpathSync(entry) === fileURLToPath(import.meta.url)),
);

if (isEntrypoint) {
  const apiKey = Option.fromUndefinedOr(process.env.TYPESAFE_API_KEY);
  // The transport is only reached when a key exists; the client rejects earlier otherwise.
  const transport = createFetchTransport(
    apiEndpoint(),
    Option.getOrElse(apiKey, () => ""),
  );
  const eventLog = EventLogLive(eventsPath());
  const layers = Layer.mergeAll(
    eventLog,
    LoopGuardLive(loopStatePath()),
    JevClientLive({ apiKey, transport }).pipe(Layer.provide(eventLog)),
  );
  const code = await Effect.runPromise(runCli(process.argv.slice(2), layers));
  process.exitCode = code;
}
