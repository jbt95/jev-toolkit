import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isNotFoundError } from "./fs-errors.ts";
import { JevEvent, type Harness } from "./schema.ts";

export class EventLogError extends Data.TaggedError("EventLogError")<{
  readonly operation: "encode" | "append" | "read";
}> {}

/** Log health as seen by one read: malformed lines are skipped, never repaired. */
export interface EventLogStats {
  /** Non-empty lines in the file. */
  readonly lines: number;
  /** Lines that decoded into events. */
  readonly decoded: number;
  /** Lines that failed to decode and were skipped. */
  readonly skipped: number;
  /** Newest event timestamp in the log, or undefined when the log is empty. */
  readonly lastEventTs: string | undefined;
}

export interface EventLogScan {
  readonly events: ReadonlyArray<JevEvent>;
  readonly stats: EventLogStats;
}

export interface EventLogService {
  readonly append: (event: JevEvent) => Effect.Effect<void, EventLogError>;
  readonly read: (filter?: {
    readonly harness?: Harness;
    readonly since?: string;
  }) => Effect.Effect<ReadonlyArray<JevEvent>, EventLogError>;
  /**
   * Read events plus log health. `stats` describes the whole file, so a
   * filtered scan still reports every skipped line.
   */
  readonly scan: (filter?: {
    readonly harness?: Harness;
    readonly since?: string;
  }) => Effect.Effect<EventLogScan, EventLogError>;
}

export class EventLog extends Context.Service<EventLog, EventLogService>()("jev/EventLog") {}

const JevEventLine = Schema.fromJsonString(JevEvent);
const encodeLine = Schema.encodeEffect(JevEventLine);
const decodeLine = Schema.decodeUnknownOption(JevEventLine);

export function makeEventLog(path: string): EventLogService {
  const append = (event: JevEvent): Effect.Effect<void, EventLogError> =>
    Effect.gen(function* appendProgram() {
      const line = yield* encodeLine(event).pipe(
        Effect.mapError(() => new EventLogError({ operation: "encode" })),
      );
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true });
          await appendFile(path, `${line}\n`);
        },
        catch: () => new EventLogError({ operation: "append" }),
      });
    });

  const scan = (filter: { readonly harness?: Harness; readonly since?: string } = {}) =>
    Effect.gen(function* scanProgram() {
      const raw = yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: (cause) => cause,
      }).pipe(
        // A missing log is an empty log; every other read failure must surface.
        Effect.catchIf(isNotFoundError, () => Effect.succeed("")),
        Effect.mapError(() => new EventLogError({ operation: "read" })),
      );
      const events: Array<JevEvent> = [];
      let lines = 0;
      let lastEventTs: string | undefined;
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        lines += 1;
        const parsed = decodeLine(line);
        // Malformed lines are skipped, never repaired; scan reports how many.
        if (Option.isNone(parsed)) continue;
        events.push(parsed.value);
        if (lastEventTs === undefined || parsed.value.ts > lastEventTs) {
          lastEventTs = parsed.value.ts;
        }
      }
      const filtered = events.filter(
        (event) =>
          Option.fromUndefinedOr(filter.harness).pipe(
            Option.map((harness) => event.harness === harness),
            Option.getOrElse(() => true),
          ) &&
          Option.fromUndefinedOr(filter.since).pipe(
            Option.map((since) => event.ts >= since),
            Option.getOrElse(() => true),
          ),
      );
      return {
        events: filtered,
        stats: { lines, decoded: events.length, skipped: lines - events.length, lastEventTs },
      };
    });

  return {
    append,
    scan,
    read: (filter: { readonly harness?: Harness; readonly since?: string } = {}) =>
      scan(filter).pipe(Effect.map((result) => result.events)),
  };
}

export const EventLogLive = (path: string): Layer.Layer<EventLog> =>
  Layer.succeed(EventLog, makeEventLog(path));
