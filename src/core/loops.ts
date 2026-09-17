import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class LoopError extends Data.TaggedError("LoopError")<{
  readonly operation: "read" | "write";
}> {}

const LoopRecord = Schema.Struct({
  count: Schema.Number,
  lastTs: Schema.Number,
  escalated: Schema.Boolean,
  sample: Schema.optional(Schema.String),
});
const LoopState = Schema.Record(Schema.String, LoopRecord);
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(LoopState));

interface LoopRecordValue {
  count: number;
  lastTs: number;
  escalated: boolean;
  sample?: string;
}

export interface LoopCheck {
  readonly count: number;
  readonly escalated: boolean;
}

export interface LoopRecent {
  readonly fingerprint: string;
  readonly sample: string;
}

export interface LoopGuardService {
  readonly check: (fingerprint: string, sample?: string) => Effect.Effect<LoopCheck, LoopError>;
  readonly recent: (limit: number) => Effect.Effect<ReadonlyArray<LoopRecent>, LoopError>;
}

export class LoopGuard extends Context.Service<LoopGuard, LoopGuardService>()("jev/LoopGuard") {}

const PRUNE_MS = 24 * 60 * 60 * 1000;
const ESCALATE_AT = 3;

/** Stable identity for a recurring failure: whitespace- and case-insensitive. */
export const fingerprint = (text: string): string =>
  createHash("sha256")
    .update(text.trim().toLowerCase().replace(/\s+/gu, " "))
    .digest("hex")
    .slice(0, 12);

export function makeLoopGuard(path: string): LoopGuardService {
  const readState = (): Effect.Effect<Map<string, LoopRecordValue>, LoopError> =>
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: () => new LoopError({ operation: "read" }),
      }).pipe(Effect.orElseSucceed(() => "{}"));
      const decoded = decodeState(raw);
      const state = new Map<string, LoopRecordValue>();
      if (Option.isSome(decoded)) {
        for (const [key, value] of Object.entries(decoded.value)) {
          const copy: LoopRecordValue = {
            count: value.count,
            lastTs: value.lastTs,
            escalated: value.escalated,
          };
          const sample = Option.fromUndefinedOr(value.sample);
          if (Option.isSome(sample)) copy.sample = sample.value;
          state.set(key, copy);
        }
      }
      return state;
    });

  const writeState = (state: Map<string, LoopRecordValue>): Effect.Effect<void, LoopError> =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        await writeFile(tmp, JSON.stringify(Object.fromEntries(state)));
        await rename(tmp, path);
      },
      catch: () => new LoopError({ operation: "write" }),
    });

  const check = (fp: string, sample?: string): Effect.Effect<LoopCheck, LoopError> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const state = yield* readState();
      for (const [key, record] of state) {
        if (now - record.lastTs > PRUNE_MS) state.delete(key);
      }
      const current = state.get(fp);
      const count = (current?.count ?? 0) + 1;
      const escalate = count >= ESCALATE_AT && !(current?.escalated ?? false);
      const record: LoopRecordValue = {
        count,
        lastTs: now,
        escalated: (current?.escalated ?? false) || escalate,
      };
      const nextSample = Option.firstSomeOf([
        Option.fromUndefinedOr(sample),
        Option.fromUndefinedOr(current).pipe(
          Option.flatMap((seen) => Option.fromUndefinedOr(seen.sample)),
        ),
      ]);
      if (Option.isSome(nextSample)) record.sample = nextSample.value;
      state.set(fp, record);
      yield* writeState(state);
      return { count, escalated: escalate };
    });

  const recent = (limit: number): Effect.Effect<ReadonlyArray<LoopRecent>, LoopError> =>
    Effect.gen(function* () {
      const state = yield* readState();
      return [...state.entries()]
        .filter(([, record]) => Option.isSome(Option.fromUndefinedOr(record.sample)))
        .sort(([fa, a], [fb, b]) => b.lastTs - a.lastTs || fa.localeCompare(fb))
        .slice(0, limit)
        .map(([fp, record]) => ({
          fingerprint: fp,
          sample: Option.fromUndefinedOr(record.sample).pipe(Option.getOrElse(() => "")),
        }));
    });

  return { check, recent };
}

export const LoopGuardLive = (path: string): Layer.Layer<LoopGuard> =>
  Layer.succeed(LoopGuard, makeLoopGuard(path));
