// Stdio MCP server: one tool (`typesafe_ask`) behind newline-delimited
// JSON-RPC 2.0. This is the single judgment surface for every MCP-capable
// harness; native integrations only add triggers. Shapes mirror
// ~/personal/leadline/src/mcp.rs: version-echoing `initialize` (with an
// `instructions` field hosts may inject), strict `tools/call` validation,
// and text-content tool results. stdout carries only JSON-RPC lines.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createInterface } from "node:readline";
import {
  describeJevError,
  formatAnswers,
  type AskInput,
  type AskResult,
  type JevError,
} from "../core/client.ts";
import { CONTEXT_POLICY } from "../core/directives.ts";
import { Harness, QuestionMap } from "../core/schema.ts";

export type JsonValue = Schema.Schema.Type<typeof Schema.Json>;

export type McpToolOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly text: string };

export interface McpDeps {
  readonly call: (args: JsonValue) => Promise<McpToolOutcome>;
}

const JsonValueSchema = Schema.Json;

const JsonRpcRequest = Schema.Struct({
  jsonrpc: Schema.optional(Schema.String),
  id: Schema.optional(JsonValueSchema),
  method: Schema.optional(Schema.String),
  params: Schema.optional(JsonValueSchema),
});
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcRequest));

const ToolCallParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(JsonValueSchema),
});
const decodeToolCallParams = Schema.decodeUnknownOption(ToolCallParams);

const InitializeParams = Schema.Struct({ protocolVersion: Schema.optional(Schema.String) });
const decodeInitializeParams = Schema.decodeUnknownOption(InitializeParams);

const AskArgs = Schema.Struct({
  state: JsonValueSchema,
  questions: QuestionMap,
  model: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
});
const decodeAskArgs = Schema.decodeUnknownEffect(AskArgs);

const TOOL_NAME = "typesafe_ask";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

const INPUT_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    state: {
      type: ["string", "object", "array"],
      description: "Content to evaluate: text, or structured JSON with named fields.",
    },
    questions: {
      type: "object",
      description:
        "Map of question id to question. Each: { _tag: 'choice', instructions, criteria: {option: description} } | " +
        "{ _tag: 'noul', instructions, criteria?: {true, false} } | " +
        "{ _tag: 'score', instructions, criteria: [level, level, ...] }.",
      additionalProperties: true,
    },
    model: { type: "string", description: "TypeSafe model, default jev-latest." },
  },
  required: ["state", "questions"],
  additionalProperties: false,
};

const TOOL_DESCRIPTION =
  "Ask TypeSafe/Jev typed questions over a state and get calibrated, structured answers. " +
  "Primitives: choice (pick one of a defined set), noul (probability of yes), score " +
  "(probability-weighted rating across ordered levels). Use for narrow judgments the code " +
  "path needs: routing, ranking, extraction, verification. Every call is logged locally.";

const ok = (id: JsonValue, result: JsonValue): string =>
  JSON.stringify({ jsonrpc: "2.0", id, result });

const failure = (id: JsonValue, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

const initializeResult = (params: JsonValue | undefined): JsonValue => {
  let protocolVersion = DEFAULT_PROTOCOL_VERSION;
  if (params !== undefined) {
    const decoded = decodeInitializeParams(params);
    if (Option.isSome(decoded) && decoded.value.protocolVersion !== undefined) {
      protocolVersion = decoded.value.protocolVersion;
    }
  }
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "jev", version: SERVER_VERSION },
    instructions: `${CONTEXT_POLICY} Tool: ${TOOL_NAME}.`,
  };
};

const toolsCall = async (
  id: JsonValue,
  params: JsonValue | undefined,
  deps: McpDeps,
): Promise<string> => {
  const parsed = decodeToolCallParams(params);
  if (Option.isNone(parsed)) return failure(id, -32602, "tools/call requires { name, arguments? }");
  if (parsed.value.name !== TOOL_NAME) {
    return failure(id, -32602, `unknown tool '${parsed.value.name}'`);
  }
  const result = await deps.call(parsed.value.arguments ?? {});
  if (result.ok) return ok(id, { content: [{ type: "text", text: result.text }] });
  return ok(id, { content: [{ type: "text", text: result.text }], isError: true });
};

export async function handleMcpRequest(line: string, deps: McpDeps): Promise<string | undefined> {
  const request = decodeRequest(line);
  if (Option.isNone(request)) return failure(null, -32700, "parse error");
  const id = request.value.id ?? null;
  if (request.value.jsonrpc !== "2.0" || request.value.method === undefined) {
    return failure(id, -32600, "invalid request");
  }
  const method = request.value.method;
  // Notifications are acknowledgements and take no response.
  if (method === "initialized" || method.startsWith("notifications/")) return undefined;
  switch (method) {
    case "initialize":
      return ok(id, initializeResult(request.value.params));
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: [
          {
            name: TOOL_NAME,
            description: TOOL_DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
            annotations: {
              title: "TypeSafe Ask",
              readOnlyHint: true,
              idempotentHint: false,
              openWorldHint: true,
            },
          },
        ],
      });
    case "tools/call":
      return await toolsCall(id, request.value.params, deps);
    default:
      return failure(id, -32601, `unknown method '${method}'`);
  }
}

/** Wire a Jev ask function (from the provided layers) into MCP deps. */
export function createMcpDeps(
  harness: Harness,
  ask: (input: AskInput) => Effect.Effect<AskResult, JevError>,
): McpDeps {
  return {
    call: async (args) => {
      const decoded = await Effect.runPromise(Effect.result(decodeAskArgs(args)));
      if (decoded._tag === "Failure") {
        return { ok: false, text: `invalid typesafe_ask arguments: ${decoded.failure.message}` };
      }
      const payload = decoded.success;
      const outcome = await Effect.runPromise(
        Effect.result(
          ask({
            harness,
            state: payload.state,
            questions: payload.questions,
            model: payload.model ?? undefined,
          }),
        ),
      );
      if (outcome._tag === "Failure") return { ok: false, text: describeJevError(outcome.failure) };
      return { ok: true, text: formatAnswers(outcome.success) };
    },
  };
}

/** Serve MCP over stdio until stdin closes. */
export async function serveMcp(deps: McpDeps): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    const response = await handleMcpRequest(line, deps);
    if (response !== undefined) process.stdout.write(`${response}\n`);
  }
}
