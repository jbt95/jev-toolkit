import * as Layer from "effect/Layer";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevTransport } from "../core/client.ts";
import { EventLogLive, type EventLog } from "../core/events.ts";

/** Temp events.jsonl path for tests. */
export const tempEventsPath = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), "jev-test-")), "events.jsonl");

/** EventLog layer backed by a temp file (test composition root). */
export const TestEventLog = (path: string): Layer.Layer<EventLog> => EventLogLive(path);

/** JevTransport fake over an injected send function. */
export const makeTestTransport = (send: JevTransport["send"]): JevTransport => ({ send });
