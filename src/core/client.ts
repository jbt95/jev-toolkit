import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { callLogger } from "./call-log.ts";
import { EventLog, type EventLogService } from "./events.ts";
import type { Answer, AnswerMap, Harness, Question, QuestionMap } from "./schema.ts";

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
/**
 * True when every requested question has an answer of the matching shape. Both
 * transports gate on this before returning, so a partial response never looks
 * like a judgment.
 */
export const answersCoverQuestions = (questions: QuestionMap, answers: AnswerMap): boolean => {
  const requested = Object.entries(questions);
  const answered = Object.keys(answers);
  return (
    answered.length === requested.length &&
    requested.every(([id, question]) =>
      Option.fromUndefinedOr(answers[id]).pipe(
        Option.exists((answer) => answerMatchesQuestion(question, answer)),
      ),
    )
  );
};

export const answerMatchesQuestion = (question: Question, answer: Answer): boolean => {
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

export const describeJevError = (error: JevError): string =>
  error._tag === "JevApiError" ? `TypeSafe API error ${error.status}` : error._tag;

export function makeJevClient(
  config: JevClientConfig & { readonly log: EventLogService },
): JevClientService {
  const { apiKey, transport, log } = config;

  const logCall = callLogger(log);

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
          errorTag: "JevConfigError",
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
          errorTag: outcome.failure._tag,
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
          errorTag: "JevDecodeError",
        });
        return yield* Effect.fail(new JevDecodeError());
      }

      const answers: AnswerMap = Object.fromEntries(
        Object.entries(decoded.success.answers).map(([id, answer]) => [id, toAnswer(answer)]),
      );
      if (!answersCoverQuestions(input.questions, answers)) {
        yield* logCall(input, {
          status: "error",
          latencyMs,
          model,
          error: "TypeSafe response did not answer the requested questions",
          errorTag: "JevDecodeError",
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

/** Plain words for a yes-probability, so `0.73` reads as a verdict. */
const noulVerdict = (p: number): string => {
  if (p >= 0.8) return "very likely yes";
  if (p >= 0.6) return "likely yes";
  if (p > 0.4) return "toss-up";
  if (p > 0.2) return "likely no";
  return "very likely no";
};

/** Low-confidence flag: below ~0.4 the model found no clear signal. */
const lowFlag = (confidence: number): string =>
  confidence < 0.4 ? " — LOW, treat as no signal" : "";

/** Score levels are often `"label — description"`; keep the line to the label. */
const shortLevel = (level: string): string => level.split(/\s+[—–-]\s+|\s*:\s*/u)[0] ?? level;

/** Weighted score index rendered against its ordered levels, when known. */
const scoreVerdict = (score: number, levels: ReadonlyArray<string>): string => {
  const labels = levels.map(shortLevel);
  const max = labels.length - 1;
  const clamped = Math.min(Math.max(score, 0), max);
  const lo = Math.floor(clamped);
  const hi = Math.ceil(clamped);
  const near = labels[lo] ?? String(lo);
  if (lo === hi) return near;
  const far = labels[hi] ?? String(hi);
  return `between ${near} and ${far}, leans ${clamped - lo < 0.5 ? near : far}`;
};

const formatAnswer = (id: string, answer: Answer, questions?: QuestionMap): string => {
  switch (answer._tag) {
    case "noul":
      return `p(yes)=${answer.noul} — ${noulVerdict(answer.noul)}`;
    case "choice":
      return `${answer.choice} (confidence ${answer.confidence}${lowFlag(answer.confidence)})`;
    case "score": {
      const question = questions?.[id];
      const levels =
        question !== undefined && question._tag === "score" ? question.criteria : undefined;
      const base = `${answer.score} (confidence ${answer.confidence}${lowFlag(answer.confidence)})`;
      return levels === undefined || levels.length === 0
        ? base
        : `${answer.score} → ${scoreVerdict(answer.score, levels)} (confidence ${answer.confidence}${lowFlag(answer.confidence)})`;
    }
  }
};

export function formatAnswers(result: AskResult, questions?: QuestionMap): string {
  const lines = Object.entries(result.answers).map(
    ([id, answer]) => `${id}: ${formatAnswer(id, answer, questions)}`,
  );
  return [
    `jev ${result.model}`,
    ...lines,
    `usage: ${result.usage.input} in / ${result.usage.output} out`,
  ].join("\n");
}
