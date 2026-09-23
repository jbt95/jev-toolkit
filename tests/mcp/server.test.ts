import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";
import { JevConfigError, type AskInput, type AskResult } from "@/core/client.ts";
import { makeEventLog } from "@/core/events.ts";
import type { AnswerMap } from "@/core/schema.ts";
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
const askResult = (answers: AnswerMap): AskResult => ({
  model: "jev-test",
  answers,
  usage: { input: 10, output: 2 },
});
const supportedAnswers = (input: AskInput): AnswerMap =>
  Object.fromEntries(
    Object.keys(input.questions).map((id) => [
      id,
      { _tag: "choice", choice: "supported", confidence: 0.9, probabilities: {} },
    ]),
  );
const request = (body: JsonValue): string => JSON.stringify(body);

describe("MCP server", () => {
  it("initializes and lists ask, rank, and verify with routing guidance", async () => {
    const deps = createMcpDeps({ harness: "script", ask: () => Effect.never });
    const initialized = await handleMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      deps,
    );
    const listed = await handleMcpRequest(
      request({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      deps,
    );

    const init = JSON.parse(String(initialized));
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.instructions).toContain("Use typesafe_ask for");
    expect(init.result.instructions).toContain("Use typesafe_rank to order");
    expect(init.result.instructions).toContain("Use typesafe_verify to check");
    const tools = JSON.parse(String(listed)).result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      "typesafe_ask",
      "typesafe_rank",
      "typesafe_verify",
    ]);
    expect(tools[0].inputSchema.required).toEqual(["state", "questions"]);
    expect(tools[1].inputSchema.required).toEqual(["query", "candidates"]);
    expect(tools[2].inputSchema.required).toEqual(["claims", "evidence"]);
    expect(tools[1].description).toContain("order or prioritize");
  });

  it("returns formatted ask answers and accepts JSON-encoded questions", async () => {
    const seen: Array<AskInput> = [];
    const deps = createMcpDeps({
      harness: "pi",
      ask: (input) => {
        seen.push(input);
        return Effect.succeed(askResult({ q1: { _tag: "noul", noul: 0.99 } }));
      },
    });
    const tool = deps.tools[0];
    const outcome = await tool?.call({
      state: "text",
      questions: JSON.stringify({ q1: { _tag: "noul", instructions: "Yes?" } }),
    });

    expect(outcome).toEqual({
      ok: true,
      text: "jev jev-test\nq1: p(yes)=0.99 — very likely yes\nusage: 10 in / 2 out",
    });
    expect(seen[0]?.purpose).toBe("ask");
  });

  it("reports invalid ask arguments and typed client failures", async () => {
    const invalid = createMcpDeps({ harness: "script", ask: () => Effect.never });
    const invalidResult = await invalid.tools[0]?.call({ state: "text", questions: "{bad" });
    expect(invalidResult?.ok).toBe(false);
    expect(invalidResult?.text).toContain("Provide both required fields state and questions");

    const failing = createMcpDeps({
      harness: "script",
      ask: () => Effect.fail(new JevConfigError()),
    });
    expect(
      await failing.tools[0]?.call({
        state: "text",
        questions: { q1: { _tag: "noul", instructions: "Yes?" } },
      }),
    ).toEqual({ ok: false, text: "JevConfigError" });
  });

  it("ranks a supplied shortlist by per-candidate relevance scores", async () => {
    let seen: AskInput | undefined;
    const deps = createMcpDeps({
      harness: "script",
      ask: (input) => {
        seen = input;
        return Effect.succeed(
          askResult({
            candidate_0_relevance: { _tag: "noul", noul: 0.4 },
            candidate_1_relevance: { _tag: "noul", noul: 0.9 },
            candidate_2_relevance: { _tag: "noul", noul: 0.9 },
          }),
        );
      },
    });
    const outcome = await deps.tools[1]?.call({
      query: "Find timeout documentation. Authorization: Bearer abcdefgh",
      candidates: [
        { id: "lower", text: "A timeout is retried." },
        { id: "top-a", text: "Timeout retry policy." },
        { id: "top-b", text: "Other timeout retry details." },
      ],
    });

    expect(seen?.purpose).toBe("rank");
    expect(seen?.state).toEqual({
      query: "Find timeout documentation. Authorization: [redacted]",
      candidates: [
        "A timeout is retried.",
        "Timeout retry policy.",
        "Other timeout retry details.",
      ],
    });
    expect(Object.values(seen?.questions ?? {}).every((question) => question._tag === "noul")).toBe(
      true,
    );
    expect(outcome?.ok).toBe(true);
    expect(JSON.parse(outcome?.text ?? "{}").ranking).toEqual([
      { id: "top-a", relevance: 0.9 },
      { id: "top-b", relevance: 0.9 },
      { id: "lower", relevance: 0.4 },
    ]);
  });

  it("rejects code, diff, and transcript text before sending it to TypeSafe", async () => {
    let calls = 0;
    const deps = createMcpDeps({
      harness: "script",
      ask: () => {
        calls += 1;
        return Effect.fail(new JevConfigError());
      },
    });
    const rank = deps.tools[1];
    const unsafeTexts = [
      "```ts\nconst apiKey = 'not-a-real-key';\n```",
      "diff --git a/src/file.ts b/src/file.ts\n@@ -1 +1 @@\n-old\n+new",
      '{"type":"assistant","message":"transcript content"}',
      "const token = 'example';",
      "print(token)",
      "apiKey = 'example'",
      "void copy(void) { secret(); }",
    ];

    for (const text of unsafeTexts) {
      const outcome = await rank?.call({
        query: "find relevant docs",
        candidates: [{ id: "candidate", text }],
      });
      expect(outcome?.ok).toBe(false);
    }
    const unsafeQuery = await rank?.call({
      query: "export function send() { return secret; }",
      candidates: [{ id: "candidate", text: "A relevant document." }],
    });

    expect(unsafeQuery?.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it("rejects empty, excessive, duplicate, and oversized ranking inputs", async () => {
    let calls = 0;
    const deps = createMcpDeps({
      harness: "script",
      ask: () => {
        calls += 1;
        return Effect.never;
      },
    });
    const rank = deps.tools[1];
    const empty = await rank?.call({ query: "find", candidates: [] });
    const excessive = await rank?.call({
      query: "find",
      candidates: Array.from({ length: 21 }, (_, index) => ({
        id: `c${index}`,
        text: "candidate",
      })),
    });
    const duplicate = await rank?.call({
      query: "find",
      candidates: [
        { id: "same", text: "one" },
        { id: "same", text: "two" },
      ],
    });
    const oversized = await rank?.call({
      query: "find",
      candidates: [{ id: "large", text: "x".repeat(40_001) }],
    });

    expect([empty?.ok, excessive?.ok, duplicate?.ok, oversized?.ok]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(calls).toBe(0);
  });

  it("verifies evidence, reports missing numbers, and logs only a summary", async () => {
    const path = await tempEventsPath();
    const log = makeEventLog(path);
    const purposes: Array<AskInput["purpose"]> = [];
    const answers: AnswerMap = {
      c0_verdict: { _tag: "choice", choice: "supported", confidence: 0.9, probabilities: {} },
      c1_verdict: { _tag: "choice", choice: "contradicted", confidence: 0.8, probabilities: {} },
    };
    const deps = createMcpDeps({
      harness: "script",
      ask: (input) => {
        purposes.push(input.purpose);
        return Effect.succeed(askResult(answers));
      },
      log,
    });

    const outcome = await deps.tools[2]?.call({
      claims: [
        { id: "c0", text: "2 tests pass" },
        { id: "c1", text: "coverage is 90%" },
      ],
      evidence: "tests passed: 2; coverage: 82%",
      sessionID: "session-verify",
    });

    expect(outcome?.ok).toBe(true);
    expect(outcome?.text).toContain("c0: supported");
    expect(outcome?.text).toContain("c1: contradicted");
    expect(outcome?.text).toContain("numbers not in evidence: 90%");
    expect(purposes[0]).toBe("verify");
    const events = await Effect.runPromise(log.read());
    expect(JSON.stringify(events)).not.toContain("coverage is 90%");
    expect(JSON.stringify(events)).not.toContain("coverage: 82%");
    expect(events).toEqual([
      expect.objectContaining({
        _tag: "verify",
        sessionID: "session-verify",
        summary: {
          claims: 2,
          supported: 1,
          contradicted: 1,
          unrelated: 0,
          insufficient: 0,
          needs_evidence: 1,
        },
      }),
    ]);
  });

  it("accepts JSON-encoded claims and rejects empty, excessive, or oversized input", async () => {
    const deps = createMcpDeps({
      harness: "script",
      ask: (input) => Effect.succeed(askResult(supportedAnswers(input))),
    });
    const encoded = await deps.tools[2]?.call({
      claims: JSON.stringify([{ id: "c0", text: "one test passes" }]),
      evidence: "one test passes",
    });
    expect(encoded?.ok).toBe(true);

    const empty = await deps.tools[2]?.call({ claims: [], evidence: "x" });
    const excessive = await deps.tools[2]?.call({
      claims: Array.from({ length: 21 }, (_, index) => ({ id: `c${index}`, text: "claim" })),
      evidence: "x",
    });
    const oversized = await deps.tools[2]?.call({
      claims: [{ id: "c0", text: "claim" }],
      evidence: "x".repeat(40_001),
    });
    expect(empty?.ok).toBe(false);
    expect(excessive?.ok).toBe(false);
    expect(oversized?.ok).toBe(false);
  });

  it("rejects unknown tools and acknowledges notifications", async () => {
    const deps = depsWith(async () => ({ ok: true, text: "done" }));
    const unknown = await handleMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "typesafe_review" },
      }),
      deps,
    );
    const notification = await handleMcpRequest(
      request({ jsonrpc: "2.0", method: "notifications/initialized" }),
      deps,
    );
    expect(JSON.parse(String(unknown)).error.code).toBe(-32602);
    expect(notification).toBeUndefined();
  });

  it("serves request lines across arbitrary Web Stream chunks", async () => {
    const encoder = new TextEncoder();
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"jsonrpc":"2.0","id":1,"method":'));
        controller.enqueue(
          encoder.encode(
            '"ping"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"typesafe_ask","arguments":{"state":"x","questions":{}}}}\n',
          ),
        );
        controller.close();
      },
    });
    let written = "";
    await serveMcp(
      depsWith(async () => ({ ok: true, text: "done" })),
      input,
      (chunk) => {
        written += chunk;
      },
    );

    expect(written).toContain('"id":1');
    expect(written).toContain('"id":2');
    expect(written).toContain("done");
  });
});
