import { afterEach, describe, expect, it } from "vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  requestQuestionIds,
  startFakeApi,
  tempDir,
  type FakeApi,
  type WireAnswer,
  type WireResponse,
} from "../helpers.ts";

const CLI = fileURLToPath(new URL("../../src/cli/jev.ts", import.meta.url));

const apiResponder = (body: string): string => {
  const answers: Record<string, WireAnswer> = {};
  for (const id of requestQuestionIds(body)) answers[id] = { type: "noul", noul: 0.99 };
  const response: WireResponse = {
    model: "jev-e2e",
    answers,
    usage: { input_tokens: 3, output_tokens: 1 },
  };
  return JSON.stringify(response);
};

const CallLine = Schema.Struct({
  _tag: Schema.Literal("call"),
  harness: Schema.String,
  sessionID: Schema.optional(Schema.String),
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
  JEV_HARNESS: "opencode2",
});

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = (
  args: ReadonlyArray<string>,
  env: Record<string, string>,
  input = "",
): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });

const callEvents = async (dataDir: string): Promise<ReadonlyArray<CallLine>> => {
  try {
    const raw = await readFile(join(dataDir, "events.jsonl"), "utf8");
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

describe("jev CLI end to end", () => {
  it("asks the API, prints the answer, and logs the call with its session", async () => {
    api = await startFakeApi(apiResponder);
    const dataDir = await tempDir();
    const payload = JSON.stringify({
      state: { question: "ship?" },
      questions: { q1: { _tag: "noul", instructions: "Is shipping safe?" } },
      sessionID: "ses_e2e",
    });

    const result = await runCli(["ask"], envFor(api, dataDir), payload);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("p(yes)=0.99");
    const calls = await callEvents(dataDir);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.harness).toBe("opencode2");
    expect(calls[0]?.sessionID).toBe("ses_e2e");
    expect(calls[0]?.status).toBe("ok");
  });

  it("tails the local event log through the real entrypoint", async () => {
    api = await startFakeApi(apiResponder);
    const dataDir = await tempDir();
    const env = envFor(api, dataDir);
    await runCli(
      ["ask"],
      env,
      JSON.stringify({
        state: "x",
        questions: { q1: { _tag: "noul", instructions: "yes?" } },
      }),
    );

    const result = await runCli(["events", "--n", "1"], env);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"_tag":"call"');
  });

  it("prints the directive for a quantitative prompt via the CLI hook", async () => {
    api = await startFakeApi(apiResponder);
    const dataDir = await tempDir();

    const result = await runCli(
      ["hook", "prompt"],
      envFor(api, dataDir),
      JSON.stringify({ prompt: "Should we ship, and how likely is it to pass?" }),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[Jev policy]");
  });

  it("serves the MCP tool over stdio", async () => {
    api = await startFakeApi(apiResponder);
    const dataDir = await tempDir();
    const child = spawn(process.execPath, [CLI, "mcp"], {
      env: { ...process.env, ...envFor(api, dataDir) },
      stdio: ["pipe", "pipe", "pipe"],
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
    ];
    const stdout = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("mcp server timed out"));
      }, 15000);
      child.stdout.on("data", (chunk) => {
        buffer += String(chunk);
        if (buffer.split("\n").filter((line) => line.trim().length > 0).length >= requests.length) {
          clearTimeout(timer);
          child.kill();
          resolve(buffer);
        }
      });
      child.once("error", reject);
      for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    });

    const responses = stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => Option.toArray(decodeMcp(line)));
    const toolsList = responses.find((response) => response.id === 2);
    const toolCall = responses.find((response) => response.id === 3);
    expect(JSON.stringify(toolsList?.result)).toContain("sessionID");
    expect(JSON.stringify(toolCall?.result)).toContain("p(yes)=0.99");

    const calls = await callEvents(dataDir);
    expect(calls[0]?.sessionID).toBe("ses_mcp");
  });

  it("prints usage and exits 1 for an unknown command", async () => {
    api = await startFakeApi(apiResponder);

    const result = await runCli(["nope"], envFor(api, await tempDir()));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage: jev <command>");
  });

  it("serves Prometheus metrics on JEV_METER_PORT", async () => {
    api = await startFakeApi(apiResponder);
    const dataDir = await tempDir();
    const port = 18700 + (process.pid % 500);
    const child = spawn(process.execPath, [CLI, "meter", "serve"], {
      env: { ...process.env, ...envFor(api, dataDir), JEV_METER_PORT: String(port) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      let health: Response | undefined;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          health = await fetch(`http://127.0.0.1:${port}/health`);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      expect(health?.status).toBe(200);
      const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(await metrics.text()).toContain("jev_calls_total");
    } finally {
      child.kill();
    }
  });
});
