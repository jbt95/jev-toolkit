import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { EventLog, type EventLogService } from "./events.ts";
import type { Answer, AnswerMap, CallEvent, Harness, Question, QuestionMap } from "./schema.ts";

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

export function createFetchTransport(endpoint: string, apiKey: string): JevTransport {
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

// The TypeSafe wire format tags questions/answers with `type`; the internal
// dialect uses Effect Schema `_tag`. Convert at this boundary only.
type ApiCriteria = ReadonlyArray<string> | Readonly<Record<string, string>>;

interface ApiQuestion {
  type: "choice" | "noul" | "score";
  instructions: string;
  criteria?: ApiCriteria;
}

const toApiQuestion = (question: Question): ApiQuestion => {
  const converted: ApiQuestion = { type: question._tag, instructions: question.instructions };
  const criteria = Option.fromNullishOr(question.criteria);
  if (Option.isSome(criteria)) {
    converted.criteria = criteria.value;
  }
  return converted;
};

const ApiNoulAnswer = Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Number });
const ApiChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  confidence: Schema.Number,
  probabilities: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
});
const ApiScoreAnswer = Schema.Struct({
  type: Schema.Literal("score"),
  score: Schema.Number,
  confidence: Schema.Number,
  probabilities: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
});
const ApiAnswer = Schema.Union([ApiNoulAnswer, ApiChoiceAnswer, ApiScoreAnswer]);
type ApiAnswer = Schema.Schema.Type<typeof ApiAnswer>;

const toAnswer = (answer: ApiAnswer): Answer => {
  switch (answer.type) {
    case "noul":
      return { _tag: "noul", noul: answer.noul };
    case "choice":
      return {
        _tag: "choice",
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities ?? {},
      };
    case "score":
      return {
        _tag: "score",
        score: answer.score,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
      };
  }
};

const inUnitInterval = (value: number): boolean => value >= 0 && value <= 1;

const probabilitiesInRange = (probabilities: Readonly<Record<string, number>>): boolean =>
  Object.values(probabilities).every(inUnitInterval);

type ChoiceQuestion = Extract<Question, { readonly _tag: "choice" }>;
type ScoreQuestion = Extract<Question, { readonly _tag: "score" }>;

const noulMatches = (answer: Answer): boolean =>
  answer._tag === "noul" && inUnitInterval(answer.noul);

const choiceMatches = (question: ChoiceQuestion, answer: Answer): boolean =>
  answer._tag === "choice" &&
  inUnitInterval(answer.confidence) &&
  Object.hasOwn(question.criteria, answer.choice) &&
  probabilitiesInRange(answer.probabilities);

const scoreMatches = (question: ScoreQuestion, answer: Answer): boolean => {
  if (answer._tag !== "score") return false;
  if (!inUnitInterval(answer.confidence)) return false;
  if (!Number.isFinite(answer.score) || answer.score < 0) return false;
  const maxScore = question.criteria.length - 1;
  if (maxScore >= 0 && answer.score > maxScore) return false;
  const probabilities = Option.fromUndefinedOr(answer.probabilities);
  return Option.isNone(probabilities) || probabilitiesInRange(probabilities.value);
};

/**
 * Schema validation only proves shape; a response is trustworthy only when
 * every requested question is answered with its own primitive, a choice from
 * its criteria, and bounded numbers. Anything else must fail closed.
 */
const answerMatchesQuestion = (question: Question, answer: Answer): boolean => {
  switch (question._tag) {
    case "noul":
      return noulMatches(answer);
    case "choice":
      return choiceMatches(question, answer);
    case "score":
      return scoreMatches(question, answer);
  }
};

const JevResponse = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(Schema.String, ApiAnswer),
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

export const describeJevError = (error: JevError): string =>
  error._tag === "JevApiError" ? `TypeSafe API error ${error.status}` : error._tag;

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

      const body = JSON.stringify({
        state: input.state,
        questions: Object.fromEntries(
          Object.entries(input.questions).map(([id, question]) => [id, toApiQuestion(question)]),
        ),
        model,
      });
      const outcome = yield* Effect.result(transport.send(body));
      const latencyMs = (yield* Clock.currentTimeMillis) - started;

      if (outcome._tag === "Failure") {
        yield* logCall(input, {
          status: "error",
          latencyMs,
          model,
          error: describeJevError(outcome.failure),
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

      const answers: AnswerMap = Object.fromEntries(
        Object.entries(decoded.success.answers).map(([id, answer]) => [id, toAnswer(answer)]),
      );
      const requested = Object.entries(input.questions);
      const answered = Object.keys(decoded.success.answers);
      const consistent =
        answered.length === requested.length &&
        requested.every(([id, question]) =>
          Option.fromUndefinedOr(answers[id]).pipe(
            Option.exists((answer) => answerMatchesQuestion(question, answer)),
          ),
        );
      if (!consistent) {
        yield* logCall(input, {
          status: "error",
          latencyMs,
          model,
          error: "TypeSafe response did not answer the requested questions",
        });
        return yield* Effect.fail(new JevDecodeError());
      }
      const result: AskResult = {
        model: decoded.success.model,
        answers,
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

const formatAnswer = Match.type<Answer>().pipe(
  Match.tag("noul", (answer) => `p(yes)=${answer.noul}`),
  Match.tag("choice", (answer) => `${answer.choice} (confidence ${answer.confidence})`),
  Match.tag("score", (answer) => `${answer.score} (confidence ${answer.confidence})`),
  Match.exhaustive,
);

export function formatAnswers(result: AskResult): string {
  const lines = Object.entries(result.answers).map(
    ([id, answer]) => `${id}: ${formatAnswer(answer)}`,
  );
  return [
    `jev ${result.model}`,
    ...lines,
    `usage: ${result.usage.input} in / ${result.usage.output} out`,
  ].join("\n");
}
