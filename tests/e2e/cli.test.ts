import { afterEach, describe, expect, it } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  joinPath,
  readText,
  requestQuestionIds,
  startFakeApi,
  tempDir,
  type FakeApi,
  type WireAnswer,
  type WireResponse,
} from "../helpers.ts";

const CLI = Bun.fileURLToPath(new URL("../../src/cli/jev.ts", import.meta.url));

const answerForQuestion = (id: string): WireAnswer =>
  id.endsWith("_verdict")
    ? { type: "choice", choice: "supported", confidence: 0.9, probabilities: { supported: 0.9 } }
    : { type: "noul", noul: id === "candidate_0_relevance" ? 0.2 : 0.99 };

const apiResponder = (body: string): string =>
  JSON.stringify({
    model: "jev-e2e",
    answers: Object.fromEntries(requestQuestionIds(body).map((id) => [id, answerForQuestion(id)])),
    usage: { input_tokens: 3, output_tokens: 1 },
  } satisfies WireResponse);

const CallLine = Schema.Struct({
  _tag: Schema.Literal("call"),
  harness: Schema.String,
  sessionID: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.String),
  status: Schema.String,
});
const decodeCall = Schema.decodeUnknownOption(Schema.fromJsonString(CallLine));
type CallLine = Schema.Schema.Type<typeof CallLine>;

const McpResponse = Schema.Struct({ id: Schema.Number, result: Schema.Json });
const decodeMcp = Schema.decodeUnknownOption(Schema.fromJsonString(McpResponse));

const envFor = (api: FakeApi, dataDir: string) => ({
  TYPESAFE_API_KEY: "test-key",
  JEV_ENDPOINT: api.url,
  JEV_DATA_DIR: dataDir,
  JEV_HARNESS: "opencode",
});

const callEvents = async (dataDir: string): Promise<ReadonlyArray<CallLine>> => {
  try {
    const raw = await readText(joinPath(dataDir, "events.jsonl"));
    const calls: Array<CallLine> = [];
    for (const line of raw.split("\n")) {
      const decoded = decodeCall(line);
      if (Option.isSome(decoded)) calls.push(decoded.value);
    }
    return calls;
  } catch {
    return [];
  }
};

let api: FakeApi | undefined;

afterEach(async () => {
  await api?.close();
  api = undefined;
});

describe("jev MCP server end to end", () => {
  it("serves ask, rank, and verify over stdio MCP", async () => {
    api = await startFakeApi(apiResponder);
    const dataDir = await tempDir();
    const child = Bun.spawn([Bun.which("bun") ?? "bun", CLI, "mcp"], {
      env: { ...Bun.env, ...envFor(api, dataDir) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "typesafe_ask",
          arguments: {
            state: "charged twice",
            questions: { q1: { _tag: "noul", instructions: "duplicate?" } },
            sessionID: "ses_mcp",
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "typesafe_rank",
          arguments: {
            query: "Which excerpt describes retries?",
            candidates: [
              { id: "lower", text: "A retry may happen." },
              { id: "higher", text: "The client retries after timeouts." },
            ],
            sessionID: "ses_rank",
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "typesafe_verify",
          arguments: {
            claims: [{ id: "tests", text: "12 tests pass" }],
            evidence: "test output: 12 tests passed",
            sessionID: "ses_verify",
          },
        },
      },
    ];
    child.stdin.write(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
    child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const responses = stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => Option.toArray(decodeMcp(line)));
    const toolsList = responses.find((response) => response.id === 2);
    const ask = responses.find((response) => response.id === 3);
    const ranked = responses.find((response) => response.id === 4);
    const verify = responses.find((response) => response.id === 5);
    const listed = JSON.stringify(toolsList?.result);
    expect(listed).toContain("typesafe_ask");
    expect(listed).toContain("typesafe_rank");
    expect(listed).toContain("typesafe_verify");
    expect(listed).not.toContain("typesafe_review");
    expect(listed).not.toContain("typesafe_skill_route");
    expect(JSON.stringify(ask?.result)).toContain("p(yes)=0.99");
    const rankingText = JSON.stringify(ranked?.result);
    expect(rankingText.indexOf("higher")).toBeLessThan(rankingText.indexOf("lower"));
    expect(JSON.stringify(verify?.result)).toContain("tests: supported");

    const calls = await callEvents(dataDir);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.sessionID)).toEqual(["ses_mcp", "ses_rank", "ses_verify"]);
    expect(calls.map((call) => call.purpose)).toEqual(["ask", "rank", "verify"]);
    const eventLog = await readText(joinPath(dataDir, "events.jsonl"));
    expect(eventLog).not.toContain("Which excerpt describes retries?");
    expect(eventLog).not.toContain("The client retries after timeouts.");
  });
});
