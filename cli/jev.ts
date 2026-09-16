import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  correlate,
  extractClaude,
  extractOpencode,
  extractPiOmp,
  type CorrelatedOpportunity,
  type RawOpportunity,
} from "../audit/opportunities.ts";
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
import { serveMeter } from "../core/metrics.ts";
import {
  apiEndpoint,
  claudeProjectsDir,
  eventsPath,
  ompSessionsDir,
  opencodeDbPath,
  piSessionsDir,
} from "../core/paths.ts";
import { Harness, QuestionMap } from "../core/schema.ts";

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
  opportunities: ReadonlyArray<CorrelatedOpportunity>,
  dryRun: boolean,
): void => {
  const summary = new Map<string, { total: number; matched: number }>();
  for (const opportunity of opportunities) {
    const entry = summary.get(opportunity.harness) ?? { total: 0, matched: 0 };
    entry.total += 1;
    if (opportunity.matched) entry.matched += 1;
    summary.set(opportunity.harness, entry);
  }
  console.log(
    `harness        opportunities matched missed compliance${dryRun ? " (dry run)" : ""}`,
  );
  const rows = [...summary.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [harness, counts] of rows) {
    const missed = counts.total - counts.matched;
    const compliance =
      counts.total === 0 ? "0.0%" : `${((counts.matched / counts.total) * 100).toFixed(1)}%`;
    console.log(
      `${harness.padEnd(15)}${String(counts.total).padEnd(14)}${String(counts.matched).padEnd(8)}${String(missed).padEnd(7)}${compliance}`,
    );
  }
};

export function runCli(
  argv: ReadonlyArray<string>,
  layers: Layer.Layer<JevClient | EventLog>,
  stdin: () => Effect.Effect<string, string> = readStdin,
): Effect.Effect<number> {
  const [command, ...rest] = argv;

  const program: Effect.Effect<number, string, JevClient | EventLog> = Effect.gen(function* () {
    switch (command) {
      case "ask": {
        const client = yield* JevClient;
        const raw = yield* stdin();
        const payload = yield* decodeAskPayload(raw).pipe(
          Effect.mapError(
            () => "invalid ask payload on stdin: expected {state, questions, model?}",
          ),
        );
        const result = yield* client
          .ask({
            harness: "cli",
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

        const events = yield* log
          .read()
          .pipe(Effect.mapError((error) => `event log ${error.operation} failed`));
        const correlated = correlate(opportunities, events);
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
          printAuditSummary(correlated, dryRun);
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
    JevClientLive({ apiKey, transport }).pipe(Layer.provide(eventLog)),
  );
  const code = await Effect.runPromise(runCli(process.argv.slice(2), layers));
  process.exitCode = code;
}
