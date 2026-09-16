import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  JevClient,
  JevClientLive,
  createFetchTransport,
  describeJevError,
  formatAnswers,
} from "../core/client.ts";
import { EventLog, EventLogLive } from "../core/events.ts";
import { apiEndpoint, eventsPath } from "../core/paths.ts";
import { Harness, QuestionMap } from "../core/schema.ts";

const AskPayload = Schema.Struct({
  state: Schema.Json,
  questions: QuestionMap,
  model: Schema.optional(Schema.NonEmptyString),
});
const decodeAskPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(AskPayload));

const USAGE = `usage: jev <command>

commands:
  ask      read {state, questions, model?} JSON on stdin and print TypeSafe answers
  events   print recent events as JSON lines ([--n N] [--harness <id>])`;

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
            model: payload.model,
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
