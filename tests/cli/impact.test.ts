import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { runCli } from "@/cli/jev.ts";
import { makeEventLog } from "@/core/events.ts";
import { apiResponse, cliLayers, tempEventsPath } from "../helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jev impact", () => {
  it("prints a JSON cohort report from the event log", async () => {
    const path = await tempEventsPath();
    const log = makeEventLog(path);
    const now = new Date().toISOString();
    await Effect.runPromise(
      log.append({
        _tag: "call",
        ts: now,
        harness: "opencode",
        sessionID: "assisted",
        callID: "call-secret",
        model: "jev-test",
        latencyMs: 10,
        status: "ok",
        questions: [{ id: "q1", type: "choice" }],
      }),
    );
    await Effect.runPromise(
      log.append({
        _tag: "checkpoint",
        ts: now,
        harness: "opencode",
        sessionID: "assisted",
        callID: "call-secret",
        kind: "test",
        result: "pass",
        source: "ci",
      }),
    );
    await Effect.runPromise(
      log.append({
        _tag: "session_label",
        ts: now,
        harness: "opencode",
        sessionID: "assisted",
        outcome: "shipped",
        friction: 1,
        waste: "none",
        taskType: "feature",
      }),
    );
    await Effect.runPromise(
      log.append({
        _tag: "session_label",
        ts: now,
        harness: "opencode",
        sessionID: "unassisted",
        outcome: "blocked",
        friction: 4,
        waste: "loop",
        taskType: "feature",
      }),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await Effect.runPromise(
      runCli(
        ["impact", "--harness", "opencode", "--json"],
        cliLayers(path, () => apiResponse({})),
      ),
    );

    expect(code).toBe(0);
    const report = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(report.coverage).toMatchObject({
      callEvents: 1,
      assistedLabeledSessions: 1,
      unassistedLabeledSessions: 1,
    });
    expect(report.comparisons).toHaveLength(1);
    expect(report.comparisons[0]).toMatchObject({
      harness: "opencode",
      taskType: "feature",
      assisted: { sessions: 1, outcomes: { shipped: 1 } },
      unassisted: { sessions: 1, outcomes: { blocked: 1 } },
    });
    expect(String(logSpy.mock.calls[0]?.[0])).not.toContain("call-secret");
    expect(String(logSpy.mock.calls[0]?.[0])).not.toContain('"sessionID"');
  });
});
