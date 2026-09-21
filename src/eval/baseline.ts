import * as Schema from "effect/Schema";
import type { PackLabReport } from "./pack-lab.ts";

/**
 * A saved `jev eval pack --json` report, decoded at the boundary. Comparing a
 * new run against one of these turns model, prompt, and threshold changes into
 * evidence instead of a guess.
 */
const CaseReportView = Schema.Struct({
  id: Schema.NonEmptyString,
  summary: Schema.Record(Schema.String, Schema.Number),
  expected: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  agreed: Schema.optional(Schema.Boolean),
  meanConfidence: Schema.optional(Schema.Number),
  maxSpread: Schema.Number,
  unstableAnswers: Schema.Array(Schema.String),
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  latencyMs: Schema.Number,
});

export const BaselineReport = Schema.Struct({
  pack: Schema.String,
  model: Schema.String,
  repeat: Schema.Number,
  cases: Schema.Array(CaseReportView),
  compared: Schema.Number,
  agreed: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  meanLatencyMs: Schema.Number,
});
export type BaselineReport = Schema.Schema.Type<typeof BaselineReport>;

export const decodeBaselineReport = Schema.decodeUnknownEffect(
  Schema.fromJsonString(BaselineReport),
);

export interface DriftEntry {
  readonly id: string;
  readonly key: string;
  readonly before: number;
  readonly after: number;
}

export interface BaselineComparison {
  readonly baselineModel: string;
  readonly currentModel: string;
  readonly sharedCases: number;
  readonly newCases: ReadonlyArray<string>;
  readonly missingCases: ReadonlyArray<string>;
  /** Cases whose expectations were met in the baseline and are missed now. */
  readonly regressions: ReadonlyArray<string>;
  /** Numeric summary keys whose value changed for a case in both reports. */
  readonly drift: ReadonlyArray<DriftEntry>;
}

/**
 * Compare a run against a saved baseline by case id. A regression is a case
 * the baseline satisfied whose expectations the current run misses; drift is
 * any numeric summary value that changed. Both are evidence, not verdicts:
 * the caller owns the policy that turns them into an exit code.
 */
export const compareToBaseline = (
  current: PackLabReport,
  baseline: BaselineReport,
): BaselineComparison => {
  const currentById = new Map(current.cases.map((entry) => [entry.id, entry]));
  const baselineById = new Map(baseline.cases.map((entry) => [entry.id, entry]));
  const regressions: Array<string> = [];
  const drift: Array<DriftEntry> = [];
  for (const [id, before] of baselineById) {
    const after = currentById.get(id);
    if (after === undefined) continue;
    if (before.agreed === true && after.agreed === false) regressions.push(id);
    for (const [key, value] of Object.entries(before.summary)) {
      const now = after.summary[key];
      if (now !== undefined && now !== value) {
        drift.push({ id, key, before: value, after: now });
      }
    }
  }
  return {
    baselineModel: baseline.model,
    currentModel: current.model,
    sharedCases: current.cases.filter((entry) => baselineById.has(entry.id)).length,
    newCases: current.cases.flatMap((entry) => (baselineById.has(entry.id) ? [] : [entry.id])),
    missingCases: baseline.cases.flatMap((entry) => (currentById.has(entry.id) ? [] : [entry.id])),
    regressions,
    drift,
  };
};
