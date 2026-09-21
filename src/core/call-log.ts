import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { EventLogService } from "./events.ts";
import type { AnswerMap, CallEvent, Harness, JevErrorTag, QuestionMap } from "./schema.ts";

/** Fields every call event carries besides the request identity. */
export interface CallLogFields {
  readonly status: "ok" | "error";
  readonly latencyMs: number;
  readonly model: string;
  readonly error?: string;
  /** Typed failure kind; text descriptions change, tags do not. */
  readonly errorTag?: JevErrorTag;
  readonly answers?: AnswerMap;
  readonly tokens?: { readonly input: number; readonly output: number };
}

/** The part of an ask that identifies the call in the log. */
export interface CallIdentity {
  readonly harness: Harness;
  readonly sessionID?: string | undefined;
  readonly questions: QuestionMap;
}

/** Question ids and types only: prompts, criteria, and answers stay out. */
export const summarizeQuestions = (
  questions: QuestionMap,
): ReadonlyArray<{ readonly id: string; readonly type: "choice" | "noul" | "score" }> =>
  Object.entries(questions).map(([id, question]) => ({ id, type: question._tag }));

/** The logger both transports append call events through. */
export interface CallLogger {
  (input: CallIdentity, fields: CallLogFields): Effect.Effect<void>;
}

/**
 * One logger for every transport. Both clients write the same event shape, so
 * a field added here reaches fetches and SDK calls alike; logging never fails
 * a judgment call.
 */
export const callLogger =
  (log: EventLogService): CallLogger =>
  (input: CallIdentity, fields: CallLogFields): Effect.Effect<void> =>
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
        errorTag: fields.errorTag,
        answers: fields.answers,
        tokens: fields.tokens,
        questions: summarizeQuestions(input.questions),
      };
      yield* log.append(event);
    }).pipe(Effect.orElseSucceed(() => undefined));
