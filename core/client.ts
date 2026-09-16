import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { EventLog, type EventLogService } from "./events.ts";
import { AnswerMap, type CallEvent, type Harness, type QuestionMap } from "./schema.ts";

export const DEFAULT_MODEL = "jev-latest";
const TIMEOUT = "120 seconds";

export class JevConfigError extends Data.TaggedError("JevConfigError")<{}> {}
export class JevTransportError extends Data.TaggedError("JevTransportError")<{}> {}
export class JevDecodeError extends Data.TaggedError("JevDecodeError")<{}> {}
export class JevTimeoutError extends Data.TaggedError("JevTimeoutError")<{}> {}
export class JevApiError extends Data.TaggedError("JevApiError")<{
  readonly status: number;
}> {}

export type JevError =
  | JevConfigError
  | JevTransportError
  | JevDecodeError
  | JevTimeoutError
  | JevApiError;

/** Anything JSON-shaped may be judged: text or structured state. */
export type JevState = Schema.Schema.Type<typeof Schema.Json>;

export type JevTransportFailure = JevTransportError | JevApiError | JevTimeoutError;

export interface JevTransport {
  readonly send: (body: string) => Effect.Effect<string, JevTransportFailure>;
}

export function makeFetchTransport(endpoint: string, apiKey: string): JevTransport {
  return {
    send: (body) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(endpoint, {
              method: "POST",
              signal,
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body,
            }),
          catch: () => new JevTransportError(),
        });
        const text = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: () => new JevTransportError(),
        });
        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.fail(new JevApiError({ status: response.status }));
        }
        return text;
      }).pipe(
        Effect.timeoutOption(TIMEOUT),
        Effect.flatMap((timed) =>
          Option.isNone(timed) ? Effect.fail(new JevTimeoutError()) : Effect.succeed(timed.value),
        ),
      ),
  };
}

const JevResponse = Schema.Struct({
  model: Schema.String,
  answers: AnswerMap,
  usage: Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number }),
});
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(JevResponse));

export interface AskInput {
  readonly harness: Harness;
  readonly state: JevState;
  readonly questions: QuestionMap;
  readonly model?: string;
  readonly sessionID?: string;
}

export interface AskResult {
  readonly model: string;
  readonly answers: AnswerMap;
  readonly usage: { readonly input: number; readonly output: number };
}

export interface JevClientService {
  readonly ask: (input: AskInput) => Effect.Effect<AskResult, JevError>;
}

export class JevClient extends Context.Service<JevClient, JevClientService>()("jev/JevClient") {}

export interface JevClientConfig {
  readonly apiKey: Option.Option<string>;
  readonly transport: JevTransport;
}

interface CallLogFields {
  readonly status: "ok" | "error";
  readonly latencyMs: number;
  readonly model: string;
  readonly error?: string;
  readonly answers?: AnswerMap;
  readonly tokens?: { readonly input: number; readonly output: number };
}

const summarizeQuestions = (
  questions: QuestionMap,
): ReadonlyArray<{ readonly id: string; readonly type: "choice" | "noul" | "score" }> =>
  Object.entries(questions).map(([id, question]) => ({ id, type: question._tag }));

const describeFailure = (failure: JevTransportFailure): string =>
  failure._tag === "JevApiError" ? `TypeSafe API error ${failure.status}` : failure._tag;

export function makeJevClient(
  config: JevClientConfig & { readonly log: EventLogService },
): JevClientService {
  const { apiKey, transport, log } = config;

  // Event logging must never fail a judgment call.
  const logCall = (input: AskInput, fields: CallLogFields): Effect.Effect<void> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const event: CallEvent = {
        _tag: "call",
        ts: new Date(now).toISOString(),
        harness: input.harness,
        model: fields.model,
        latencyMs: fields.latencyMs,
        status: fields.status,
        sessionID: input.sessionID,
        error: fields.error,
        answers: fields.answers,
        tokens: fields.tokens,
        questions: summarizeQuestions(input.questions),
      };
      yield* log.append(event);
    }).pipe(Effect.orElseSucceed(() => undefined));

  const ask = (input: AskInput): Effect.Effect<AskResult, JevError> =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const model = input.model ?? DEFAULT_MODEL;

      if (Option.isNone(apiKey)) {
        yield* logCall(input, {
          status: "error",
          latencyMs: 0,
          model,
          error: "TYPESAFE_API_KEY is not set; export it where the harness process can see it.",
        });
        return yield* Effect.fail(new JevConfigError());
      }

      const body = JSON.stringify({ state: input.state, questions: input.questions, model });
      const outcome = yield* Effect.result(transport.send(body));
      const latencyMs = (yield* Clock.currentTimeMillis) - started;

      if (outcome._tag === "Failure") {
        yield* logCall(input, {
          status: "error",
          latencyMs,
          model,
          error: describeFailure(outcome.failure),
        });
        return yield* Effect.fail(outcome.failure);
      }

      const decoded = yield* Effect.result(decodeResponse(outcome.success));
      if (decoded._tag === "Failure") {
        yield* logCall(input, {
          status: "error",
          latencyMs,
          model,
          error: "TypeSafe response did not match the expected shape",
        });
        return yield* Effect.fail(new JevDecodeError());
      }

      const result: AskResult = {
        model: decoded.success.model,
        answers: decoded.success.answers,
        usage: {
          input: decoded.success.usage.input_tokens,
          output: decoded.success.usage.output_tokens,
        },
      };
      yield* logCall(input, {
        status: "ok",
        latencyMs,
        model: result.model,
        answers: result.answers,
        tokens: result.usage,
      });
      return result;
    });

  return { ask };
}

export const JevClientLive = (config: JevClientConfig): Layer.Layer<JevClient, never, EventLog> =>
  Layer.effect(
    JevClient,
    Effect.gen(function* () {
      const log = yield* EventLog;
      return makeJevClient({ ...config, log });
    }),
  );

export function formatAnswers(result: AskResult): string {
  const lines = Object.entries(result.answers).map(([id, answer]) => {
    switch (answer._tag) {
      case "noul":
        return `${id}: p(yes)=${answer.noul}`;
      case "choice":
        return `${id}: ${answer.choice} (confidence ${answer.confidence})`;
      case "score":
        return `${id}: ${answer.score} (confidence ${answer.confidence})`;
    }
  });
  return [
    `jev ${result.model}`,
    ...lines,
    `usage: ${result.usage.input} in / ${result.usage.output} out`,
  ].join("\n");
}
