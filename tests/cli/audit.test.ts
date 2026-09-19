import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  delete process.env.JEV_OMP_SESSIONS_DIR;
  delete process.env.JEV_PI_SESSIONS_DIR;
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
        harness: "opencode",
        sessionID: "sess-1",
        model: "jev-test",
        latencyMs: 5,
        status: "ok",
        questions: [{ id: "q1", type: "noul" }],
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["audit", "run", "--harness", "opencode"], cliLayers(path, respond)),
    );

    expect(code).toBe(0);
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("opencode");
    expect(output).toContain("100.0%");
    const events = await Effect.runPromise(makeEventLog(path).read());
    const opportunities = events.filter((event) => event._tag === "opportunity");
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.matched).toBe(true);
  });

  it("infers an unattributed call's session from the transcript and audits user prompts", async () => {
    const db = await makeOpencodeDb();
    db.insertMessage(
      "u1",
      "user",
      Date.now() - 1000,
      "Assess how we can achieve that",
      "sess-infer",
    );
    db.insertAsk("a1", "sess-infer", Date.now() - 900, ["recommendation", "causal_claim"]);
    process.env.JEV_OPENCODE_DB = db.path;
    const path = await tempEventsPath();
    await Effect.runPromise(
      makeEventLog(path).append({
        _tag: "call",
        ts: new Date().toISOString(),
        harness: "opencode",
        // No sessionID: the MCP transport cannot carry one.
        model: "jev-test",
        latencyMs: 5,
        status: "ok",
        questions: [
          { id: "recommendation", type: "choice" },
          { id: "causal_claim", type: "choice" },
        ],
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["audit", "run", "--harness", "opencode"], cliLayers(path, respond)),
    );

    expect(code).toBe(0);
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("100.0%");
    const events = await Effect.runPromise(makeEventLog(path).read());
    const opportunities = events.filter((event) => event._tag === "opportunity");
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.source).toBe("user_prompt");
    expect(opportunities[0]?.matched).toBe(true);
  });

  it("stays unmatched and writes nothing on a dry run without attributed calls", async () => {
    const db = await makeOpencodeDb();
    db.insertMessage("m1", "assistant", Date.now() - 1000, "About 70% of parsers break here.");
    process.env.JEV_OPENCODE_DB = db.path;
    const path = await tempEventsPath();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["audit", "run", "--harness", "opencode", "--dry-run"], cliLayers(path, respond)),
    );

    expect(code).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("0.0%");
    const events = await Effect.runPromise(makeEventLog(path).read());
    expect(events.filter((event) => event._tag === "opportunity")).toEqual([]);
  });

  it("attributes an omp subagent call to its parent session", async () => {
    const root = await mkdtemp(join(tmpdir(), "jev-omp-root-"));
    const emptyPiRoot = await mkdtemp(join(tmpdir(), "jev-pi-root-"));
    process.env.JEV_OMP_SESSIONS_DIR = root;
    process.env.JEV_PI_SESSIONS_DIR = emptyPiRoot;
    const at = new Date(Date.now() - 60_000).toISOString();
    const parentFile = join(root, "-proj", "2026-09-19T09-00-00-000Z_parent-sess.jsonl");
    await mkdir(dirname(parentFile), { recursive: true });
    await writeFile(
      parentFile,
      `${JSON.stringify({
        type: "message",
        id: "m1",
        timestamp: at,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "About 70% of parsers break here." }],
        },
      })}\n`,
    );
    const childFile = join(root, "-proj", "child.jsonl");
    const childLines: ReadonlyArray<unknown> = [
      { type: "session", version: 3, id: "child-sess", timestamp: at, parentSession: parentFile },
      {
        type: "message",
        id: "m2",
        timestamp: at,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "write",
              arguments: {
                path: "xd://mcp__jev_typesafe_ask",
                content: JSON.stringify({
                  state: "s",
                  questions: { recommendation: { _tag: "noul" } },
                }),
              },
            },
          ],
        },
      },
    ];
    await writeFile(childFile, `${childLines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    const path = await tempEventsPath();
    await Effect.runPromise(
      makeEventLog(path).append({
        _tag: "call",
        ts: new Date().toISOString(),
        harness: "omp",
        // No sessionID: no harness forwards one over MCP.
        model: "jev-test",
        latencyMs: 5,
        status: "ok",
        questions: [{ id: "recommendation", type: "noul" }],
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["audit", "run", "--harness", "omp"], cliLayers(path, respond)),
    );

    expect(code).toBe(0);
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("total: messages=1 detected=1 matched=1");
    const events = await Effect.runPromise(makeEventLog(path).read());
    const opportunities = events.filter((event) => event._tag === "opportunity");
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.harness).toBe("omp");
    expect(opportunities[0]?.matched).toBe(true);
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
    db.insertMessage("p1", "user", Date.now() - 1000, "no regex pattern here");
    db.insertMessage("p2", "user", Date.now() - 999, "Should we ship now?");
    process.env.JEV_OPENCODE_DB = db.path;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["audit", "prompts"], cliLayers(await tempEventsPath(), respond)),
    );

    expect(code).toBe(0);
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("prompts=2");
    expect(output).toContain("jev_detected=1");
    expect(output).toContain("missed by regex (examples):");
    expect(output).toContain("routed by Jev (examples):");
    expect(output).toContain("regex-tagged but not routed by Jev (examples):");
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
