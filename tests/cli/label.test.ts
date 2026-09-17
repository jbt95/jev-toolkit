import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { runCli } from "@/cli/jev.ts";
import { makeEventLog } from "@/core/events.ts";
import {
  apiResponse,
  cliLayers,
  makeOpencodeDb,
  tempEventsPath,
  type WireAnswer,
  type WireResponse,
} from "../helpers.ts";

const labelAnswers = () =>
  ({
    s0_outcome: { type: "choice", choice: "shipped", confidence: 0.9, probabilities: {} },
    s0_friction: { type: "score", score: 2, confidence: 0.8 },
    s0_waste: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
    s0_task_type: { type: "choice", choice: "feature", confidence: 0.9, probabilities: {} },
  }) satisfies Readonly<Record<string, WireAnswer>>;

const respond = (): WireResponse => apiResponse(labelAnswers());

const seedSession = async (): Promise<string> => {
  const db = await makeOpencodeDb();
  db.insertSession("sess-1", "parser work", Date.now() - 1000);
  db.insertMessage("p1", "user", Date.now() - 1000, "fix the parser", "sess-1");
  db.insertMessage("m1", "assistant", Date.now() - 900, "done", "sess-1");
  process.env.JEV_OPENCODE_DB = db.path;
  return db.path;
};

afterEach(() => {
  delete process.env.JEV_OPENCODE_DB;
  vi.restoreAllMocks();
});

describe("jev label", () => {
  it("prints digests on a dry run without writing labels", async () => {
    await seedSession();
    const path = await tempEventsPath();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["label", "sessions", "--harness", "opencode2", "--dry-run"],
        cliLayers(path, respond),
      ),
    );

    expect(code).toBe(0);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain("sess-1");
    expect(await Effect.runPromise(makeEventLog(path).read())).toEqual([]);
  });

  it("labels sessions and records one label event", async () => {
    await seedSession();
    const path = await tempEventsPath();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["label", "sessions", "--harness", "opencode2"], cliLayers(path, respond)),
    );

    expect(code).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "labeled 1 of 1 candidate sessions",
    );
    const events = await Effect.runPromise(makeEventLog(path).read());
    const labels = events.filter((event) => event._tag === "session_label");
    expect(labels).toHaveLength(1);
    if (labels[0]?._tag === "session_label") {
      expect(labels[0].sessionID).toBe("sess-1");
      expect(labels[0].outcome).toBe("shipped");
      expect(labels[0].friction).toBe(2);
    }
  });

  it("rejects an unknown label subcommand", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["label"], cliLayers(await tempEventsPath(), respond)),
    );

    expect(code).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("usage: jev label sessions");
  });
});
