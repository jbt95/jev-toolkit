import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { runCli } from "@/cli/jev.ts";
import { makeEventLog } from "@/core/events.ts";
import {
  apiResponse,
  cliLayers,
  makeOpencodeDb,
  requestQuestionIds,
  tempEventsPath,
  type WireAnswer,
  type WireResponse,
} from "../helpers.ts";

const detectionAnswers = (ids: ReadonlyArray<string>) => {
  const answers: Record<string, WireAnswer> = {};
  for (const id of ids) {
    const index = Number.parseInt(id.slice(1), 10);
    if (id.endsWith("_claim")) answers[id] = { type: "noul", noul: index === 0 ? 0.9 : 0.1 };
    if (id.endsWith("_kind")) {
      answers[id] = {
        type: "choice",
        choice: index === 0 ? "percent" : "none",
        confidence: 0.9,
        probabilities: {},
      };
    }
  }
  return answers;
};

const respond = (body: string): WireResponse => {
  const ids = requestQuestionIds(body);
  if (ids.includes("a0")) return apiResponse({ a0: { type: "noul", noul: 0.9 } });
  return apiResponse(detectionAnswers(ids));
};

afterEach(() => {
  delete process.env.JEV_OPENCODE_DB;
  vi.restoreAllMocks();
});

describe("jev audit", () => {
  it("writes matched opportunities when the session's calls are attributed", async () => {
    const db = await makeOpencodeDb();
    db.insertMessage("m1", "assistant", Date.now() - 1000, "About 70% of parsers break here.");
    process.env.JEV_OPENCODE_DB = db.path;
    const path = await tempEventsPath();
    await Effect.runPromise(
      makeEventLog(path).append({
        _tag: "call",
        ts: new Date().toISOString(),
        harness: "opencode2",
        sessionID: "sess-1",
        model: "jev-test",
        latencyMs: 5,
        status: "ok",
        questions: [{ id: "q1", type: "noul" }],
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["audit", "run", "--harness", "opencode2"], cliLayers(path, respond)),
    );

    expect(code).toBe(0);
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("opencode2");
    expect(output).toContain("100.0%");
    const events = await Effect.runPromise(makeEventLog(path).read());
    const opportunities = events.filter((event) => event._tag === "opportunity");
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.matched).toBe(true);
  });

  it("stays unmatched and writes nothing on a dry run without attributed calls", async () => {
    const db = await makeOpencodeDb();
    db.insertMessage("m1", "assistant", Date.now() - 1000, "About 70% of parsers break here.");
    process.env.JEV_OPENCODE_DB = db.path;
    const path = await tempEventsPath();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["audit", "run", "--harness", "opencode2", "--dry-run"], cliLayers(path, respond)),
    );

    expect(code).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("0.0%");
    const events = await Effect.runPromise(makeEventLog(path).read());
    expect(events.filter((event) => event._tag === "opportunity")).toEqual([]);
  });

  it("reads nothing for an unknown harness filter", async () => {
    const db = await makeOpencodeDb();
    db.insertMessage("m1", "assistant", Date.now() - 1000, "About 70% done.");
    process.env.JEV_OPENCODE_DB = db.path;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["audit", "run", "--harness", "bogus", "--dry-run"],
        cliLayers(await tempEventsPath(), respond),
      ),
    );

    expect(code).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("messages=0");
  });

  it("summarizes regex tagging versus Jev detection for real prompts", async () => {
    const db = await makeOpencodeDb();
    db.insertMessage("p1", "user", Date.now() - 1000, "Should we ship now?");
    process.env.JEV_OPENCODE_DB = db.path;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["audit", "prompts"], cliLayers(await tempEventsPath(), respond)),
    );

    expect(code).toBe(0);
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("prompts=1");
    expect(output).toContain("jev_detected=1");
    expect(output).toContain("routed by Jev (examples):");
  });

  it("rejects an unknown audit subcommand", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["audit"], cliLayers(await tempEventsPath(), respond)),
    );

    expect(code).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("usage: jev audit run");
  });
});
