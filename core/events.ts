import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { JevEvent, type Harness } from "./schema.ts";

export class EventLogError extends Data.TaggedError("EventLogError")<{
  readonly operation: "encode" | "append" | "read";
}> {}

export interface EventLogService {
  readonly append: (event: JevEvent) => Effect.Effect<void, EventLogError>;
  readonly read: (filter?: {
    readonly harness?: Harness;
    readonly since?: string;
  }) => Effect.Effect<ReadonlyArray<JevEvent>, EventLogError>;
}

export class EventLog extends Context.Service<EventLog, EventLogService>()("jev/EventLog") {}

const JevEventLine = Schema.fromJsonString(JevEvent);
const encodeLine = Schema.encodeEffect(JevEventLine);
const decodeLine = Schema.decodeUnknownOption(JevEventLine);

export function makeEventLog(path: string): EventLogService {
  const append = (event: JevEvent): Effect.Effect<void, EventLogError> =>
    Effect.gen(function* () {
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

  const read = (filter: { readonly harness?: Harness; readonly since?: string } = {}) =>
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: () => new EventLogError({ operation: "read" }),
      }).pipe(Effect.orElseSucceed(() => "")); // missing file = empty log
      const events: Array<JevEvent> = [];
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        const parsed = decodeLine(line);
        if (Option.isSome(parsed)) events.push(parsed.value); // malformed lines are skipped
      }
      return events.filter(
        (event) =>
          (filter.harness === undefined || event.harness === filter.harness) &&
          (filter.since === undefined || event.ts >= filter.since),
      );
    });

  return { append, read };
}

export const EventLogLive = (path: string): Layer.Layer<EventLog> =>
  Layer.succeed(EventLog, makeEventLog(path));
