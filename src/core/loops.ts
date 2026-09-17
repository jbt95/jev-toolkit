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
});
type LoopRecordValue = Schema.Schema.Type<typeof LoopRecord>;
const LoopState = Schema.Record(Schema.String, LoopRecord);
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(LoopState));

export interface LoopCheck {
  readonly count: number;
  readonly escalated: boolean;
}

export interface LoopGuardService {
  readonly check: (fingerprint: string) => Effect.Effect<LoopCheck, LoopError>;
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
  const check = (fp: string): Effect.Effect<LoopCheck, LoopError> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const raw = yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: () => new LoopError({ operation: "read" }),
      }).pipe(Effect.orElseSucceed(() => "{}"));
      const decoded = decodeState(raw);
      const state = new Map<string, LoopRecordValue>(
        Option.isSome(decoded) ? Object.entries(decoded.value) : [],
      );
      for (const [key, record] of state) {
        if (now - record.lastTs > PRUNE_MS) state.delete(key);
      }
      const current = state.get(fp);
      const count = (current?.count ?? 0) + 1;
      const escalate = count >= ESCALATE_AT && !(current?.escalated ?? false);
      state.set(fp, { count, lastTs: now, escalated: (current?.escalated ?? false) || escalate });
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true });
          const tmp = `${path}.tmp`;
          await writeFile(tmp, JSON.stringify(Object.fromEntries(state)));
          await rename(tmp, path);
        },
        catch: () => new LoopError({ operation: "write" }),
      });
      return { count, escalated: escalate };
    });
  return { check };
}

export const LoopGuardLive = (path: string): Layer.Layer<LoopGuard> =>
  Layer.succeed(LoopGuard, makeLoopGuard(path));
