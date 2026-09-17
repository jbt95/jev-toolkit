import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { PassThrough } from "node:stream";
import { JevConfigError, type AskInput, type AskResult } from "@/core/client.ts";
import {
  createMcpDeps,
  handleMcpRequest,
  serveMcp,
  type JsonValue,
  type McpDeps,
} from "@/mcp/server.ts";

const depsWith = (call: McpDeps["call"]): McpDeps => ({ call });

const okDeps = depsWith(async () => ({
  ok: true,
  text: "jev jev-1.13.0\nis_dupe: p(yes)=0.99\nusage: 279 in / 22 out",
}));

const request = (body: JsonValue): string => JSON.stringify(body);

describe("MCP server", () => {
  it("answers initialize, echoing the requested protocol version", async () => {
    const response = await handleMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      okDeps,
    );

    const parsed = JSON.parse(String(response));
    expect(parsed.result.protocolVersion).toBe("2025-06-18");
    expect(parsed.result.capabilities.tools).toEqual({});
    expect(parsed.result.serverInfo.name).toBe("jev");
    expect(parsed.result.instructions).toContain("typesafe_ask");
  });

  it("lists exactly one tool with the required arguments", async () => {
    const response = await handleMcpRequest(
      request({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      okDeps,
    );

    const parsed = JSON.parse(String(response));
    expect(parsed.result.tools).toHaveLength(1);
    expect(parsed.result.tools[0].name).toBe("typesafe_ask");
    expect(parsed.result.tools[0].inputSchema.required).toEqual(["state", "questions"]);
    expect(parsed.result.tools[0].inputSchema.properties.sessionID.type).toBe("string");
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

  it("createMcpDeps formats real ask results and surfaces typed failures", async () => {
    const successDeps = createMcpDeps("script", () =>
      Effect.succeed({
        model: "jev-1.13.0",
        answers: { q1: { _tag: "noul", noul: 0.99 } },
        usage: { input: 10, output: 2 },
      } satisfies AskResult),
    );
    const failureDeps = createMcpDeps("script", () => Effect.fail(new JevConfigError()));

    const success = await successDeps.call({
      state: "text",
      questions: { q1: { _tag: "noul", instructions: "Yes or no?" } },
    });
    const failure = await failureDeps.call({
      state: "text",
      questions: { q1: { _tag: "noul", instructions: "Yes or no?" } },
    });
    const invalid = await successDeps.call({ state: "text", questions: { q1: { _tag: "noul" } } });

    expect(success).toEqual({
      ok: true,
      text: "jev jev-1.13.0\nq1: p(yes)=0.99\nusage: 10 in / 2 out",
    });
    expect(failure).toEqual({ ok: false, text: "JevConfigError" });
    expect(invalid.ok).toBe(false);
  });

  it("passes the optional sessionID through to ask", async () => {
    const seen: Array<AskInput> = [];
    const deps = createMcpDeps("script", (input) => {
      seen.push(input);
      return Effect.succeed({
        model: "jev-1.13.0",
        answers: { q1: { _tag: "noul", noul: 0.99 } },
        usage: { input: 10, output: 2 },
      } satisfies AskResult);
    });

    await deps.call({
      state: "text",
      questions: { q1: { _tag: "noul", instructions: "Yes or no?" } },
      sessionID: "ses_attributed",
    });

    expect(seen[0]?.sessionID).toBe("ses_attributed");
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
