// SDK-backed JevClient: the same judgment surface as client.ts, transported
// by @typesafe-ai/sdk (TypeSafeClient.systemOne calling Jev) instead of the
// hand-rolled fetch wire format. Validation, event logging, and error tags
// match makeJevClient so flows can migrate without changing callers.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  TypeSafeClient,
  TypeSafeError,
  choice as sdkChoice,
  noul as sdkNoul,
  score as sdkScore,
} from "@typesafe-ai/sdk";
import type {
  EntryType,
  Fetch,
  Question as SdkQuestion,
  Questions as SdkQuestions,
  SystemOneResult,
} from "@typesafe-ai/sdk";
import {
  DEFAULT_MODEL,
  JevApiError,
  JevClient,
  JevConfigError,
  JevDecodeError,
  JevTimeoutError,
  JevTransportError,
  answersCoverQuestions,
  describeJevError,
  requireApiKey,
  type AskInput,
  type AskResult,
  type JevClientService,
  type JevError,
} from "./client.ts";
import { callLogger } from "./call-log.ts";
import { EventLog, type EventLogService } from "./events.ts";
import type { AnswerMap, QuestionMap } from "./schema.ts";

export interface SdkClientConfig {
  readonly apiKey: Option.Option<string>;
  readonly log: EventLogService;
  readonly baseURL?: string;
  readonly fetch?: Fetch;
}

/** Map a /v1/systemone endpoint URL to the SDK base URL. */
export const sdkBaseURL = (endpoint: string): string => {
  const suffix = "/v1/systemone";
  return endpoint.endsWith(suffix) ? endpoint.slice(0, -suffix.length) : endpoint;
};

interface SdkNoulCriteria {
  true?: string;
  false?: string;
}

const noulCriteria = (
  criteria: Readonly<Record<string, string>> | null | undefined,
): SdkNoulCriteria | undefined => {
  if (criteria === null || criteria === undefined) return undefined;
  const yes = Option.fromUndefinedOr(criteria["true"]);
  const no = Option.fromUndefinedOr(criteria["false"]);
  if (Option.isNone(yes) && Option.isNone(no)) return undefined;
  const out: SdkNoulCriteria = {};
  if (Option.isSome(yes)) out.true = yes.value;
  if (Option.isSome(no)) out.false = no.value;
  return out;
};

const toSdkQuestions = (questions: QuestionMap): Option.Option<SdkQuestions> => {
  if (Object.keys(questions).length === 0) return Option.none();
  const out: Record<string, SdkQuestion> = {};
  for (const [id, question] of Object.entries(questions)) {
    switch (question._tag) {
      case "noul": {
        out[id] = sdkNoul(question.instructions, noulCriteria(question.criteria));
        break;
      }
      case "choice": {
        out[id] = sdkChoice(question.instructions, question.criteria);
        break;
      }
      case "score": {
        if (question.criteria.length < 2) return Option.none();
        const [first = "", second = "", ...rest] = question.criteria;
        out[id] = sdkScore(question.instructions, [first, second, ...rest]);
        break;
      }
    }
  }
  return Option.some(out);
};

type SdkAnswers = SystemOneResult<SdkQuestions>["answers"];

const toInternalAnswers = (answers: SdkAnswers): AnswerMap => {
  const out: Record<string, AnswerMap[string]> = {};
  for (const [id, answer] of Object.entries(answers)) {
    switch (answer.type) {
      case "noul": {
        out[id] = { _tag: "noul", noul: answer.noul };
        break;
      }
      case "choice": {
        out[id] = {
          _tag: "choice",
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: { ...answer.probabilities },
        };
        break;
      }
      case "score": {
        out[id] = {
          _tag: "score",
          score: answer.score,
          confidence: answer.confidence,
          probabilities: { ...answer.probabilities },
        };
        break;
      }
    }
  }
  return out;
};

interface SdkClientOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly fetch?: Fetch;
}

/** SDK failure classes to the shared Jev error tags; exported for its table test. */
export const mapSdkFailure = (cause: unknown): JevError => {
  if (cause instanceof APIError) return new JevApiError({ status: cause.status });
  if (cause instanceof APITimeoutError) return new JevTimeoutError();
  if (cause instanceof APIConnectionError) return new JevTransportError();
  if (cause instanceof TypeSafeError) return new JevDecodeError();
  return new JevTransportError();
};

export function makeSdkJevClient(config: SdkClientConfig): JevClientService {
  const { apiKey, log } = config;
  const logCall = callLogger(log);

  const ask = (input: AskInput): Effect.Effect<AskResult, JevError> =>
    Effect.gen(function* askProgram() {
      const started = yield* Clock.currentTimeMillis;
      const model = input.model ?? DEFAULT_MODEL;

      yield* requireApiKey(apiKey, logCall, input, model);

      const converted = toSdkQuestions(input.questions);
      if (Option.isNone(converted)) {
        yield* logCall(input, {
          status: "error",
          latencyMs: 0,
          model,
          error: "TypeSafe request did not contain valid questions",
          errorTag: "JevDecodeError",
        });
        return yield* Effect.fail(new JevDecodeError());
      }
      const sdkQuestions = converted.value;

      const options: SdkClientOptions = {
        apiKey: Option.getOrThrow(apiKey),
      };
      const withEndpoint =
        config.baseURL === undefined ? options : { ...options, baseURL: config.baseURL };
      const withFetch =
        config.fetch === undefined ? withEndpoint : { ...withEndpoint, fetch: config.fetch };
      const built = yield* Effect.result(
        Effect.try({
          try: () => new TypeSafeClient(withFetch),
          catch: () => new JevConfigError(),
        }),
      );
      if (built._tag === "Failure") {
        yield* logCall(input, {
          status: "error",
          latencyMs: 0,
          model,
          error: describeJevError(built.failure),
          errorTag: built.failure._tag,
        });
        return yield* Effect.fail(built.failure);
      }
      const client = built.success;

      // SAFETY: Jev state in this codebase is always text or a JSON
      // object/array; bare numbers/booleans never reach the client.
      const state = input.state as EntryType;
      const outcome = yield* Effect.result(
        Effect.tryPromise({
          try: () => client.systemOne({ state, questions: sdkQuestions, model }),
          catch: mapSdkFailure,
        }),
      );
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
      const response = outcome.success;

      const answers = toInternalAnswers(response.answers);
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
        model: response.model,
        answers,
        usage: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
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

export const JevClientSdkLive = (config: {
  readonly apiKey: Option.Option<string>;
  readonly baseURL?: string;
  readonly fetch?: Fetch;
}): Layer.Layer<JevClient, never, EventLog> =>
  Layer.effect(
    JevClient,
    Effect.gen(function* JevClientSdkLiveProgram() {
      const log = yield* EventLog;
      return makeSdkJevClient({ ...config, log });
    }),
  );
