import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";
import { describeJevError, type AskResult, type JevError, type JevState } from "../core/client.ts";
import type { AnswerMap, Harness, QuestionMap } from "../core/schema.ts";
import {
  ReviewInput as ReviewerInput,
  reviewQuestions as reviewerQuestions,
  routeTriage,
} from "../question-packs/reviewer-triage.ts";
import {
  ReviewInput as ProfileInput,
  evaluateReview,
  reviewQuestions as profileQuestions,
  sanitizeReviewInput,
} from "../question-packs/review-profile.ts";
import { commitQuestions, verdictFor } from "../question-packs/commit-conformance.ts";

export class PackLabError extends Data.TaggedError("PackLabError")<{
  readonly reason: string;
}> {}

export type PackAsk = (input: {
  readonly harness: Harness;
  readonly state: JevState;
  readonly questions: QuestionMap;
  readonly model?: string;
}) => Effect.Effect<AskResult, JevError>;

const EvalCase = Schema.Struct({
  id: Schema.NonEmptyString,
  /** Numeric expectations, compared exactly against the case summary. */
  expected: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  input: Schema.Json,
});
type EvalCase = Schema.Schema.Type<typeof EvalCase>;

const EvalFixture = Schema.Struct({
  pack: Schema.Literals(["reviewer", "commit", "profile"]),
  cases: Schema.Array(EvalCase),
});
type EvalFixture = Schema.Schema.Type<typeof EvalFixture>;
type EvalPack = EvalFixture["pack"];

const decodeFixture = Schema.decodeUnknownEffect(Schema.fromJsonString(EvalFixture));

const CommitEvalInput = Schema.Struct({
  message: Schema.String,
  spec: Schema.optional(Schema.String),
});

export interface PackLabOptions {
  readonly fixturePath: string;
  /** Identical repeats per case; variance across runs exposes instability. */
  readonly repeat: number;
  readonly model?: string;
}

export interface CaseReport {
  readonly id: string;
  readonly summary: Readonly<Record<string, number>>;
  readonly expected?: Readonly<Record<string, number>>;
  readonly agreed?: boolean;
  readonly meanConfidence?: number;
  /** Largest range across repeats of any numeric answer. */
  readonly maxSpread: number;
  readonly unstableAnswers: ReadonlyArray<string>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

export interface PackLabReport {
  readonly pack: string;
  readonly model: string;
  readonly repeat: number;
  readonly cases: ReadonlyArray<CaseReport>;
  readonly compared: number;
  readonly agreed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly meanLatencyMs: number;
}

interface PreparedCase {
  readonly state: JevState;
  readonly questions: QuestionMap;
  readonly summarize: (answers: AnswerMap) => Record<string, number>;
}

interface RunResult {
  readonly model: string;
  readonly answers: AnswerMap;
  readonly summary: Record<string, number>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

/** Adapt one decoded fixture input to a state, questions, and numeric summary. */
const prepareCase = (
  pack: EvalPack,
  input: Schema.Schema.Type<typeof Schema.Json>,
): Effect.Effect<PreparedCase, string> => {
  switch (pack) {
    case "reviewer":
      return Schema.decodeUnknownEffect(ReviewerInput)(input).pipe(
        Effect.mapError(
          () =>
            "input does not match reviewer findings { meta?, findings: [{ id, title, detail }] }",
        ),
        Effect.map((decoded) => ({
          state: { findings: decoded.findings },
          questions: reviewerQuestions(decoded.findings),
          summarize: (answers) => {
            const routed = routeTriage(decoded.findings, answers);
            return {
              findings: decoded.findings.length,
              blockers: routed.blockers.length,
              cosmetic: routed.cosmetic.length,
              questions: routed.questions.length,
              substantive: routed.reviewSubstantive ? 1 : 0,
              truncated: routed.truncated ? 1 : 0,
            };
          },
        })),
      );
    case "commit":
      return Schema.decodeUnknownEffect(CommitEvalInput)(input).pipe(
        Effect.mapError(() => "input does not match { message, spec? }"),
        Effect.map((decoded) => {
          const spec = Option.fromUndefinedOr(decoded.spec);
          const state: JevState = Option.isSome(spec)
            ? { message: decoded.message, spec: spec.value }
            : { message: decoded.message };
          return {
            state,
            questions: commitQuestions({
              message: decoded.message,
              spec: Option.getOrUndefined(spec),
            }),
            summarize: (answers) => {
              const verdict = verdictFor({ message: decoded.message, answers });
              return { passed: verdict.passed ? 1 : 0, failed: verdict.failed.length };
            },
          };
        }),
      );
    case "profile":
      return Schema.decodeUnknownEffect(ProfileInput)(input).pipe(
        Effect.mapError(() => "input does not match the review profile shape"),
        Effect.map((decoded) => {
          const sanitized = sanitizeReviewInput(decoded);
          return {
            state: sanitized,
            questions: profileQuestions(sanitized),
            summarize: (answers) => {
              const evaluation = evaluateReview(sanitized, answers);
              return Object.fromEntries([
                [
                  "applicable_dimensions",
                  evaluation.dimensions.filter((dimension) => dimension.applicable).length,
                ] as const,
                ...evaluation.dimensions.flatMap((dimension) =>
                  dimension.applicable && dimension.score !== undefined
                    ? [[dimension.dimension, dimension.score] as const]
                    : [],
                ),
                [`top_weakness_${evaluation.topWeakness}`, 1] as const,
              ]);
            },
          };
        }),
      );
  }
};

const runCase = (
  pack: EvalPack,
  input: Schema.Schema.Type<typeof Schema.Json>,
  options: PackLabOptions,
  ask: PackAsk,
  harness: Harness,
): Effect.Effect<RunResult, string> =>
  Effect.gen(function* () {
    const prepared = yield* prepareCase(pack, input);
    const started = yield* Clock.currentTimeMillis;
    const modelArg = Option.getOrUndefined(Option.fromUndefinedOr(options.model));
    const result = yield* ask({
      harness,
      state: prepared.state,
      questions: prepared.questions,
      model: modelArg,
    }).pipe(Effect.mapError((error) => describeJevError(error)));
    const latencyMs = (yield* Clock.currentTimeMillis) - started;
    return {
      model: result.model,
      answers: result.answers,
      summary: prepared.summarize(result.answers),
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      latencyMs,
    };
  });

const mean = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

interface AnswerStats {
  readonly maxSpread: number;
  readonly unstableAnswers: ReadonlyArray<string>;
  readonly meanConfidence?: number;
}

const answerStats = (runs: ReadonlyArray<RunResult>): AnswerStats => {
  const numericByAnswer = new Map<string, Array<number>>();
  const confidences: Array<number> = [];
  for (const run of runs) {
    for (const [id, answer] of Object.entries(run.answers)) {
      if (answer._tag === "noul") {
        const values = numericByAnswer.get(id) ?? [];
        values.push(answer.noul);
        numericByAnswer.set(id, values);
        continue;
      }
      confidences.push(answer.confidence);
      const values = numericByAnswer.get(id) ?? [];
      values.push(answer._tag === "score" ? answer.score : Number.NaN);
      numericByAnswer.set(id, values);
    }
  }
  const unstableAnswers: Array<string> = [];
  let maxSpread = 0;
  for (const [id, values] of numericByAnswer) {
    const numeric = values.filter((value) => !Number.isNaN(value));
    if (numeric.length === 0) continue;
    const spread = Math.max(...numeric) - Math.min(...numeric);
    if (spread > 0.01) unstableAnswers.push(id);
    maxSpread = Math.max(maxSpread, spread);
  }
  return {
    maxSpread,
    unstableAnswers,
    meanConfidence: confidences.length === 0 ? undefined : mean(confidences),
  };
};

const summarizeCase = (testCase: EvalCase, runs: ReadonlyArray<RunResult>): CaseReport => {
  const first = runs[0];
  const summary = first?.summary ?? {};
  const stats = answerStats(runs);
  const expected = Option.getOrUndefined(Option.fromUndefinedOr(testCase.expected));
  const agreed =
    expected === undefined
      ? undefined
      : Object.entries(expected).every(([key, value]) => summary[key] === value);
  return {
    id: testCase.id,
    summary,
    expected,
    agreed,
    meanConfidence: stats.meanConfidence,
    maxSpread: stats.maxSpread,
    unstableAnswers: stats.unstableAnswers,
    inputTokens: runs.reduce((total, run) => total + run.inputTokens, 0),
    outputTokens: runs.reduce((total, run) => total + run.outputTokens, 0),
    latencyMs: Math.round(mean(runs.map((run) => run.latencyMs))),
  };
};

/**
 * Replay a labeled fixture file through one pack. Fixtures carry the numeric
 * expectations; `repeat` exposes answer drift across identical calls, and the
 * report carries tokens and latency so packs can be compared on evidence.
 */
export const runPackLab = (
  options: PackLabOptions,
  ask: PackAsk,
  harness: Harness,
): Effect.Effect<PackLabReport, PackLabError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(options.fixturePath, "utf8"),
      catch: () => new PackLabError({ reason: `cannot read fixtures: ${options.fixturePath}` }),
    });
    const fixture = yield* decodeFixture(raw).pipe(
      Effect.mapError(
        () =>
          new PackLabError({
            reason:
              "invalid fixture file: expected { pack: reviewer|commit|profile, cases: [{ id, input, expected? }] }",
          }),
      ),
    );
    const repeat = Math.max(1, Math.min(options.repeat, 10));
    const cases: Array<CaseReport> = [];
    let model = "unknown";
    for (const testCase of fixture.cases) {
      const runs: Array<RunResult> = [];
      for (let index = 0; index < repeat; index += 1) {
        const run = yield* runCase(fixture.pack, testCase.input, options, ask, harness).pipe(
          Effect.mapError(
            (reason) => new PackLabError({ reason: `case ${testCase.id}: ${reason}` }),
          ),
        );
        model = run.model;
        runs.push(run);
      }
      cases.push(summarizeCase(testCase, runs));
    }
    const compared = cases.filter((entry) => entry.expected !== undefined);
    return {
      pack: fixture.pack,
      model,
      repeat,
      cases,
      compared: compared.length,
      agreed: compared.filter((entry) => entry.agreed === true).length,
      inputTokens: cases.reduce((total, entry) => total + entry.inputTokens, 0),
      outputTokens: cases.reduce((total, entry) => total + entry.outputTokens, 0),
      meanLatencyMs:
        cases.length === 0 ? 0 : Math.round(mean(cases.map((entry) => entry.latencyMs))),
    };
  });
