import { describe, expect, it } from "vitest";
import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { makeEventLog } from "@/core/events.ts";

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

  it("decodes the pre-rename opencode2 harness tag as opencode", async () => {
    const path = await tempLogPath();
    await appendFile(
      path,
      `${JSON.stringify({
        _tag: "call",
        ts: "2026-09-16T00:00:00.000Z",
        harness: "opencode2",
        model: "jev-1.13.0",
        latencyMs: 10,
        status: "ok",
        questions: [{ id: "q1", type: "noul" }],
      })}\n`,
    );
    const log = makeEventLog(path);
    const events = await Effect.runPromise(log.read());
    expect(events).toHaveLength(1);
    expect(events[0]?.harness).toBe("opencode");
  });

  it("reports log health: decoded, skipped, and newest timestamp", async () => {
    const path = await tempLogPath();
    await appendFile(
      path,
      `${JSON.stringify({
        _tag: "call",
        ts: "2026-09-16T00:00:00.000Z",
        harness: "cli",
        model: "jev-1.13.0",
        latencyMs: 10,
        status: "ok",
        questions: [{ id: "q1", type: "noul" }],
      })}\nnot json\n`,
    );
    await appendFile(
      path,
      `${JSON.stringify({
        _tag: "call",
        ts: "2026-09-17T00:00:00.000Z",
        harness: "cli",
        model: "jev-1.13.0",
        latencyMs: 10,
        status: "ok",
        questions: [{ id: "q1", type: "noul" }],
      })}\n`,
    );
    const log = makeEventLog(path);

    const scan = await Effect.runPromise(log.scan());

    expect(scan.events).toHaveLength(2);
    expect(scan.stats).toEqual({
      lines: 3,
      decoded: 2,
      skipped: 1,
      lastEventTs: "2026-09-17T00:00:00.000Z",
    });
  });

  it("propagates non-ENOENT read failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-test-"));
    const log = makeEventLog(dir); // a directory cannot be read as an event log

    const outcome = await Effect.runPromise(Effect.result(log.read()));

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("EventLogError");
  });
});
