import { describe, expect, it } from "vitest";
import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { makeEventLog } from "../core/events.ts";

const tempLogPath = async () => join(await mkdtemp(join(tmpdir(), "jev-test-")), "events.jsonl");

describe("EventLog", () => {
  it("round-trips a call event", async () => {
    const log = makeEventLog(await tempLogPath());
    await Effect.runPromise(
      log.append({
        _tag: "call",
        ts: "2026-09-16T00:00:00.000Z",
        harness: "cli",
        model: "jev-latest",
        latencyMs: 120,
        status: "ok",
        questions: [{ id: "q1", type: "noul" }],
      }),
    );
    const events = await Effect.runPromise(log.read());
    expect(events).toHaveLength(1);
    expect(events[0]?._tag).toBe("call");
  });

  it("skips malformed lines and tolerates a missing file", async () => {
    const missing = makeEventLog(await tempLogPath());
    expect(await Effect.runPromise(missing.read())).toHaveLength(0);

    const path = await tempLogPath();
    await appendFile(path, "not json\n");
    const log = makeEventLog(path);
    expect(await Effect.runPromise(log.read())).toHaveLength(0);
  });
});
