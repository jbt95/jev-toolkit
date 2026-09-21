import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { PassThrough } from "node:stream";
import { JevConfigError, type AskInput, type AskResult } from "@/core/client.ts";
import { makeEventLog } from "@/core/events.ts";
import type { Answer, AnswerMap } from "@/core/schema.ts";
import {
  createMcpDeps,
  handleMcpRequest,
  serveMcp,
  type JsonValue,
  type McpDeps,
  type McpTool,
} from "@/mcp/server.ts";
import { tempEventsPath } from "../helpers.ts";

const testTool = (call: McpTool["call"], name = "typesafe_ask"): McpTool => ({
  name,
  title: "Test",
  description: "test tool",
  inputSchema: { type: "object" },
  call,
});

const depsWith = (call: McpTool["call"]): McpDeps => ({ tools: [testTool(call)] });

const okDeps = depsWith(async () => ({
  ok: true,
  text: "jev jev-1.13.0\nis_dupe: p(yes)=0.99\nusage: 279 in / 22 out",
}));

const request = (body: JsonValue): string => JSON.stringify(body);

const askResult = (answers: AnswerMap): AskResult => ({
  model: "jev-1.13.0",
  answers,
  usage: { input: 10, output: 2 },
});

const reviewAnswers = (input: AskInput): AnswerMap => {
  const answers: Record<string, Answer> = {};
  for (const id of Object.keys(input.questions)) {
    if (id.endsWith("_applicable")) answers[id] = { _tag: "noul", noul: 0.9 };
    else if (id.endsWith("_score")) answers[id] = { _tag: "score", score: 2, confidence: 0.8 };
    else if (id.endsWith("_direction")) {
      answers[id] = { _tag: "choice", choice: "improved", confidence: 0.9, probabilities: {} };
    } else if (id === "top_weakness") {
      answers[id] = { _tag: "choice", choice: "security", confidence: 0.7, probabilities: {} };
    }
  }
  return answers;
};

const routeAnswers = (input: AskInput): AnswerMap => {
  const answers: Record<string, Answer> = {};
  for (const id of Object.keys(input.questions)) {
    if (id === "skill") {
      answers[id] = { _tag: "choice", choice: "debugging", confidence: 0.97, probabilities: {} };
    } else if (id === "second") {
      answers[id] = { _tag: "noul", noul: 0.44 };
    } else if (id === "dependence") {
      answers[id] = { _tag: "score", score: 2.4, confidence: 0.6 };
    }
  }
  return answers;
};

/** A `typesafe_skill_route` call with two candidates and the given task. */
const routeCall = (id: number, task: string): string =>
  request({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "typesafe_skill_route",
      arguments: {
        task,
        skills: [
          { name: "debugging", description: "Root-cause work for failures." },
          { name: "better-ui", description: "UI polish." },
        ],
      },
    },
  });

/**
 * Route answers for a two-step chain: the first set routes `debugging` with the
 * second gate open, the follow-up set answers the given pick.
 */
const chainAnswers = (
  followUp: { readonly choice: string; readonly confidence: number; readonly score: number },
  input: AskInput,
): AnswerMap =>
  Object.keys(input.questions).includes("second")
    ? { ...routeAnswers(input), second: { _tag: "noul", noul: 0.91 } }
    : {
        skill: {
          _tag: "choice",
          choice: followUp.choice,
          confidence: followUp.confidence,
          probabilities: {},
        },
        dependence: { _tag: "score", score: followUp.score, confidence: 0.7 },
      };

/**
 * Route answers where the follow-up call fails: the first set still routes
 * `debugging` with the second gate open, the second set fails.
 */
const failingFollowUpAnswers = (input: AskInput): Effect.Effect<AskResult, JevConfigError> =>
  Object.keys(input.questions).includes("second")
    ? Effect.succeed(askResult({ ...routeAnswers(input), second: { _tag: "noul", noul: 0.91 } }))
    : Effect.fail(new JevConfigError());

describe("MCP server", () => {
  it("answers initialize, echoing the requested protocol version and listing tools", async () => {
    const deps = createMcpDeps({ harness: "script", ask: () => Effect.never });
    const response = await handleMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      deps,
    );

    const parsed = JSON.parse(String(response));
    expect(parsed.result.protocolVersion).toBe("2025-06-18");
    expect(parsed.result.capabilities.tools).toEqual({});
    expect(parsed.result.serverInfo.name).toBe("jev");
    expect(parsed.result.instructions).toContain("typesafe_verify");
  });

  it("lists the ask, verify, review, and skill-route tools with their schemas", async () => {
    const deps = createMcpDeps({ harness: "script", ask: () => Effect.never });
    const response = await handleMcpRequest(
      request({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      deps,
    );

    const parsed = JSON.parse(String(response));
    const names = parsed.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual([
      "typesafe_ask",
      "typesafe_verify",
      "typesafe_review",
      "typesafe_skill_route",
    ]);
    expect(parsed.result.tools[0].inputSchema.required).toEqual(["state", "questions"]);
    expect(parsed.result.tools[1].inputSchema.required).toEqual(["claims", "evidence"]);
    expect(parsed.result.tools[2].inputSchema.required).toEqual([]);
    expect(parsed.result.tools[3].inputSchema.required).toEqual(["task", "skills"]);
  });

  it("returns formatted answers for a successful tool call", async () => {
    const response = await handleMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "typesafe_ask",
          arguments: {
            state: "My card was charged twice.",
            questions: { is_dupe: { _tag: "noul", instructions: "Duplicate charge?" } },
          },
        },
      }),
      okDeps,
    );

    const parsed = JSON.parse(String(response));
    expect(parsed.result.isError).toBeUndefined();
    expect(parsed.result.content[0].text).toContain("p(yes)=0.99");
  });

  it("routes a task to a skill and logs the decision", async () => {
    const path = await tempEventsPath();
    const log = makeEventLog(path);
    const deps = createMcpDeps({
      harness: "omp",
      ask: (input) => Effect.succeed(askResult(routeAnswers(input))),
      log,
    });

    const response = await handleMcpRequest(routeCall(8, "the export button spins forever"), deps);

    const parsed = JSON.parse(String(response));
    expect(parsed.result.isError).toBeUndefined();
    expect(parsed.result.content[0].text).toContain("load: debugging");
    expect(parsed.result.content[0].text).toContain("confidence: 0.97");

    const events = await Effect.runPromise(log.read());
    expect(events.filter((event) => event._tag === "route")[0]).toMatchObject({
      harness: "omp",
      outcome: "routed",
      skill: "debugging",
      candidates: 2,
    });
  });

  it("loads a second skill when the follow-up clears the floors", async () => {
    const path = await tempEventsPath();
    const log = makeEventLog(path);
    const questionSets: Array<ReadonlyArray<string>> = [];
    const deps = createMcpDeps({
      harness: "omp",
      ask: (input) => {
        questionSets.push(Object.keys(input.questions));
        return Effect.succeed(
          askResult(chainAnswers({ choice: "better-ui", confidence: 0.88, score: 3.1 }, input)),
        );
      },
      log,
    });

    const response = await handleMcpRequest(
      routeCall(11, "polish the settings screen after fixing its crash"),
      deps,
    );

    const text = JSON.parse(String(response)).result.content[0].text;
    expect(text).toContain("load: debugging, then better-ui");
    expect(questionSets).toHaveLength(2);
    const events = await Effect.runPromise(log.read());
    expect(events.filter((event) => event._tag === "route")[0]).toMatchObject({
      skill: "debugging",
      skills: ["debugging", "better-ui"],
    });
  });

  it("keeps the first route when the follow-up call fails", async () => {
    const deps = createMcpDeps({ harness: "omp", ask: failingFollowUpAnswers });

    const response = await handleMcpRequest(routeCall(12, "fix the crash, then polish it"), deps);

    const text = JSON.parse(String(response)).result.content[0].text;
    expect(text).toContain("load: debugging");
    expect(text).toContain("second: unavailable (JevConfigError)");
  });

  it("declines a route below the floors and rejects an empty catalog", async () => {
    const lowDependence = (input: AskInput): AnswerMap => {
      const answers = routeAnswers(input);
      return { ...answers, dependence: { _tag: "score", score: 0.4, confidence: 0.5 } };
    };
    const deps = createMcpDeps({
      harness: "omp",
      ask: (input) => Effect.succeed(askResult(lowDependence(input))),
    });

    const response = await handleMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "typesafe_skill_route",
          arguments: {
            task: "t",
            skills: [{ name: "debugging", description: "Root-cause work." }],
          },
        },
      }),
      deps,
    );
    expect(JSON.parse(String(response)).result.content[0].text).toContain(
      "load: nothing (low-dependence)",
    );

    const empty = await handleMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "typesafe_skill_route", arguments: { task: "t", skills: [] } },
      }),
      deps,
    );
    expect(JSON.parse(String(empty)).result.isError).toBe(true);
  });

  it("routes tools/call to the requested tool", async () => {
    const deps: McpDeps = {
      tools: [
        testTool(async () => ({ ok: true, text: "ask" }), "typesafe_ask"),
        testTool(async () => ({ ok: true, text: "verify" }), "typesafe_verify"),
      ],
    };
    const response = await handleMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "typesafe_verify", arguments: {} },
      }),
      deps,
    );

    expect(JSON.parse(String(response)).result.content[0].text).toBe("verify");
  });

  it("marks tool failures with isError and the error text", async () => {
    const failing = depsWith(async () => ({ ok: false, text: "JevConfigError" }));

    const response = await handleMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "typesafe_ask", arguments: {} },
      }),
      failing,
    );

    const parsed = JSON.parse(String(response));
    expect(parsed.result.isError).toBe(true);
    expect(parsed.result.content[0].text).toBe("JevConfigError");
  });

  it("rejects malformed tool calls and unknown tools with -32602", async () => {
    const missingName = await handleMcpRequest(
      request({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {} }),
      okDeps,
    );
    const unknownTool = await handleMcpRequest(
      request({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } }),
      okDeps,
    );

    expect(JSON.parse(String(missingName)).error.code).toBe(-32602);
    expect(JSON.parse(String(unknownTool)).error.code).toBe(-32602);
  });

  it("acknowledges notifications silently and rejects broken JSON", async () => {
    const notification = await handleMcpRequest(
      request({ jsonrpc: "2.0", method: "notifications/initialized" }),
      okDeps,
    );
    const broken = await handleMcpRequest("not json", okDeps);

    expect(notification).toBeUndefined();
    expect(JSON.parse(String(broken)).error.code).toBe(-32700);
  });

  it("formats real ask results and surfaces typed failures", async () => {
    const successDeps = createMcpDeps({
      harness: "script",
      ask: () =>
        Effect.succeed({
          model: "jev-1.13.0",
          answers: { q1: { _tag: "noul", noul: 0.99 } },
          usage: { input: 10, output: 2 },
        } satisfies AskResult),
    });
    const failureDeps = createMcpDeps({
      harness: "script",
      ask: () => Effect.fail(new JevConfigError()),
    });

    const success = await successDeps.tools[0]?.call({
      state: "text",
      questions: { q1: { _tag: "noul", instructions: "Yes or no?" } },
    });
    const failure = await failureDeps.tools[0]?.call({
      state: "text",
      questions: { q1: { _tag: "noul", instructions: "Yes or no?" } },
    });

    expect(success).toEqual({
      ok: true,
      text: "jev jev-1.13.0\nq1: p(yes)=0.99 — very likely yes\nusage: 10 in / 2 out",
    });
    expect(failure).toEqual({ ok: false, text: "JevConfigError" });
  });

  it("passes the optional sessionID through to ask", async () => {
    const seen: Array<AskInput> = [];
    const deps = createMcpDeps({
      harness: "script",
      ask: (input) => {
        seen.push(input);
        return Effect.succeed(askResult({ q1: { _tag: "noul", noul: 0.99 } }));
      },
    });

    await deps.tools[0]?.call({
      state: "text",
      questions: { q1: { _tag: "noul", instructions: "Yes or no?" } },
      sessionID: "ses_attributed",
    });

    expect(seen[0]?.sessionID).toBe("ses_attributed");
  });

  it("verifies claims, reports deterministic gaps, and logs a verify summary", async () => {
    const path = await tempEventsPath();
    const log = makeEventLog(path);
    const deps = createMcpDeps({
      harness: "script",
      ask: () =>
        Effect.succeed(
          askResult({
            c0_verdict: { _tag: "choice", choice: "supported", confidence: 0.9, probabilities: {} },
            c1_verdict: {
              _tag: "choice",
              choice: "contradicted",
              confidence: 0.8,
              probabilities: {},
            },
          }),
        ),
      log,
    });

    const outcome = await deps.tools[1]?.call({
      claims: [
        { id: "c0", text: "2 tests pass" },
        { id: "c1", text: "coverage is 90%" },
      ],
      evidence: "tests passed: 2; coverage: 82%",
    });

    expect(outcome?.ok).toBe(true);
    expect(outcome?.text).toContain("c0: supported");
    expect(outcome?.text).toContain("c1: contradicted");
    expect(outcome?.text).toContain("numbers not in evidence: 90%");
    const events = await Effect.runPromise(log.read());
    const triage = events.find((event) => event._tag === "triage");
    expect(triage?._tag === "triage" && triage.feature).toBe("verify");
  });

  it("rejects empty claims and oversized evidence", async () => {
    const deps = createMcpDeps({ harness: "script", ask: () => Effect.never });
    const empty = await deps.tools[1]?.call({ claims: [], evidence: "x" });
    const oversized = await deps.tools[1]?.call({
      claims: [{ id: "c0", text: "x" }],
      evidence: "x".repeat(40_001),
    });

    expect(empty?.ok).toBe(false);
    expect(oversized?.ok).toBe(false);
  });

  it("reviews a change, returns dimension JSON, and logs a review event", async () => {
    const path = await tempEventsPath();
    const log = makeEventLog(path);
    const deps = createMcpDeps({
      harness: "script",
      ask: (input) => Effect.succeed(askResult(reviewAnswers(input))),
      log,
    });

    const outcome = await deps.tools[2]?.call({ task: "add parser", diff: "diff --git a/x b/x" });

    expect(outcome?.ok).toBe(true);
    const parsed = JSON.parse(outcome?.text ?? "{}");
    expect(parsed.dimensions).toHaveLength(8);
    expect(parsed.dimensions[0]).toMatchObject({
      dimension: "correctness",
      applicable: true,
      score: 2,
    });
    expect(parsed.topWeakness).toBe("security");
    expect(parsed.usage).toEqual({ input: 10, output: 2 });

    const events = await Effect.runPromise(log.read());
    const review = events.find((event) => event._tag === "review");
    expect(review?._tag === "review" && review.dimensions["correctness"]?.score).toBe(0.5);
  });

  it("adds direct directions when a previous evaluation is supplied", async () => {
    const deps = createMcpDeps({
      harness: "script",
      ask: (input) => Effect.succeed(askResult(reviewAnswers(input))),
    });

    const outcome = await deps.tools[2]?.call({
      diff: "x",
      previousEvaluation: {
        dimensions: [{ dimension: "correctness", applicable: true, score: 1, confidence: 0.8 }],
      },
    });
    const parsed = JSON.parse(outcome?.text ?? "{}");
    const correctness = parsed.dimensions.find(
      (dimension: { dimension: string }) => dimension.dimension === "correctness",
    );
    expect(correctness.direction).toBe("improved");
  });

  it("rejects a review without context", async () => {
    const deps = createMcpDeps({ harness: "script", ask: () => Effect.never });
    const outcome = await deps.tools[2]?.call({});

    expect(outcome?.ok).toBe(false);
    expect(outcome?.text).toContain("needs at least one of");
  });

  it("serves request lines over the provided streams until close", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => {
      written += String(chunk);
    });
    const served = serveMcp(
      depsWith(async () => ({ ok: true, text: "done" })),
      input,
      output,
    );

    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    input.write("\n");
    input.write(
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"typesafe_ask","arguments":{"state":"x","questions":{}}}}\n',
    );
    input.end();
    await served;

    expect(written).toContain('"id":1');
    expect(written).toContain('"id":2');
    expect(written).toContain("done");
  });
});
