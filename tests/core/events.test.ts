import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";
import { makeEventLog } from "@/core/events.ts";
import { appendText, joinPath, tempDir } from "../helpers.ts";

const tempLogPath = async () => joinPath(await tempDir(), "events.jsonl");

const callEvent = (harness: string) => ({
  _tag: "call",
  ts: "2026-09-16T00:00:00.000Z",
  harness,
  model: "jev-test",
  latencyMs: 10,
  status: "ok",
  questions: [{ id: "q1", type: "noul" }],
});

describe("EventLog", () => {
  it("round-trips ask calls and verify summaries", async () => {
    const log = makeEventLog(await tempLogPath());
    await Effect.runPromise(
      log.append({
        _tag: "call",
        ts: "2026-09-16T00:00:00.000Z",
        harness: "cli",
        purpose: "ask",
        model: "jev-latest",
        latencyMs: 120,
        status: "ok",
        questions: [{ id: "q1", type: "noul" }],
      }),
    );
    await Effect.runPromise(
      log.append({
        _tag: "verify",
        ts: "2026-09-16T00:00:01.000Z",
        harness: "cli",
        summary: { claims: 1, supported: 1, contradicted: 0 },
      }),
    );
    const events = await Effect.runPromise(log.read());
    expect(events).toHaveLength(2);
    expect(events[0]?._tag).toBe("call");
    expect(events[1]).toMatchObject({ _tag: "verify", summary: { claims: 1 } });
  });

  it("skips malformed lines and tolerates a missing file", async () => {
    const missing = makeEventLog(await tempLogPath());
    expect(await Effect.runPromise(missing.read())).toHaveLength(0);

    const path = await tempLogPath();
    await appendText(path, `${JSON.stringify(callEvent("cli"))}\nnot json\n`);
    expect(await Effect.runPromise(makeEventLog(path).read())).toHaveLength(1);
  });

  it("decodes the pre-rename opencode2 harness tag as opencode", async () => {
    const path = await tempLogPath();
    await appendText(path, `${JSON.stringify(callEvent("opencode2"))}\n`);
    const events = await Effect.runPromise(makeEventLog(path).read());
    expect(events).toHaveLength(1);
    expect(events[0]?.harness).toBe("opencode");
  });

  it("preserves legacy event kinds and call purposes as archived records", async () => {
    const path = await tempLogPath();
    const legacyCall = { ...callEvent("cli"), purpose: "review" };
    const legacyTriage = {
      _tag: "triage",
      ts: "2026-09-16T00:00:01.000Z",
      harness: "pi",
      feature: "verify",
      summary: { claims: 1, supported: 1 },
    };
    await appendText(path, `${JSON.stringify(legacyCall)}\n${JSON.stringify(legacyTriage)}\n`);

    const events = await Effect.runPromise(makeEventLog(path).read());

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ _tag: "legacy", kind: "call", record: legacyCall });
    expect(events[1]).toMatchObject({ _tag: "legacy", kind: "triage", record: legacyTriage });
  });

  it("propagates non-ENOENT read failures", async () => {
    const dir = await tempDir();
    const outcome = await Effect.runPromise(Effect.result(makeEventLog(dir).read()));
    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("EventLogError");
  });
});
