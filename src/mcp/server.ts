// Stdio MCP server: judgment tools behind newline-delimited JSON-RPC 2.0.
// `typesafe_ask` is the generic primitive; task-shaped tools wrap question
// packs, own their state assembly, and log through the same JevClient.
// Strict stdio server shape: version-echoing `initialize`
// (with an `instructions` field hosts may inject), strict `tools/call`
// validation, and text-content tool results. stdout carries only JSON-RPC lines.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  describeJevError,
  formatAnswers,
  type AskInput,
  type AskResult,
  type JevError,
} from "../core/client.ts";
import { CONTEXT_POLICY } from "../core/directives.ts";
import type { EventLogService } from "../core/events.ts";
import { Harness, QuestionMap, type JevEvent, type ReviewDimensionResult } from "../core/schema.ts";
import { clip, redact, stripFencedCode } from "../core/text.ts";
import { skillRoute, skillRouteQuestions } from "../question-packs/skill-routing.ts";
import {
  claimVerdicts,
  evidenceQuestions,
  numbersMissingFromEvidence,
  type EvidenceClaim,
} from "../question-packs/evidence-matrix.ts";
import {
  PreviousEvaluation,
  evaluateReview,
  hasReviewContext,
  normalizeReviewScore,
  reviewQuestions,
  sanitizeReviewInput,
} from "../question-packs/review-profile.ts";

export type JsonValue = Schema.Schema.Type<typeof Schema.Json>;

export type McpToolOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly text: string };

export interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
  readonly call: (args: JsonValue) => Promise<McpToolOutcome>;
}

export interface McpDeps {
  readonly tools: ReadonlyArray<McpTool>;
}

export type JevAsk = (input: AskInput) => Effect.Effect<AskResult, JevError>;

export interface McpConfig {
  readonly harness: Harness;
  readonly ask: JevAsk;
  /** Review and verification summaries are appended here; logging never fails a call. */
  readonly log?: EventLogService;
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
  sessionID: Schema.optional(Schema.NonEmptyString),
});
const decodeAskArgs = Schema.decodeUnknownEffect(AskArgs);

const MAX_CLAIMS = 20;
const MAX_EVIDENCE_CHARS = 40_000;
const MAX_REVIEW_STATE_CHARS = 90_000;

const VerifyArgs = Schema.Struct({
  claims: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString, text: Schema.NonEmptyString })),
  evidence: Schema.String,
  sessionID: Schema.optional(Schema.NonEmptyString),
});
const decodeVerifyArgs = Schema.decodeUnknownEffect(VerifyArgs);

const ReviewArgs = Schema.Struct({
  task: Schema.optional(Schema.String),
  diff: Schema.optional(Schema.String),
  files: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.NonEmptyString, content: Schema.String })),
  ),
  repositoryContext: Schema.optional(Schema.String),
  previousEvaluation: Schema.optional(PreviousEvaluation),
  sessionID: Schema.optional(Schema.NonEmptyString),
});
const decodeReviewArgs = Schema.decodeUnknownEffect(ReviewArgs);

const MAX_SKILLS = 64;
const MAX_TASK_CHARS = 4_000;
const MAX_CRITERION_CHARS = 300;

const SkillCandidateArgs = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
});
const SkillRouteArgs = Schema.Struct({
  task: Schema.NonEmptyString,
  skills: Schema.Array(SkillCandidateArgs),
  sessionID: Schema.optional(Schema.NonEmptyString),
});
const decodeSkillRouteArgs = Schema.decodeUnknownEffect(SkillRouteArgs);

const SERVER_VERSION = "0.2.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

const ASK_INPUT_SCHEMA: JsonValue = {
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
    sessionID: {
      type: "string",
      description:
        "Optional harness session id. Pass the exact value your harness provides so " +
        "the call can be attributed to that session; never invent one.",
    },
  },
  required: ["state", "questions"],
  additionalProperties: false,
};

const VERIFY_INPUT_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      description: "Claims to verify, one per entry. Keep each claim short and self-contained.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Stable id used in the verdict lines." },
          text: { type: "string", description: "The exact claim to check." },
        },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
    evidence: {
      type: "string",
      description:
        "Serialized evidence the claims are checked against (test output, git facts, excerpts). " +
        "Credentials are redacted before the call.",
    },
    sessionID: { type: "string", description: "Optional harness session id." },
  },
  required: ["claims", "evidence"],
  additionalProperties: false,
};

const REVIEW_INPUT_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    task: { type: "string", description: "What the change was asked to do." },
    diff: { type: "string", description: "Focused diff under review." },
    files: {
      type: "array",
      description: "Surrounding files needed to judge the change (at most 8).",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    repositoryContext: {
      type: "string",
      description: "Relevant conventions, invariants, and test results.",
    },
    previousEvaluation: {
      type: "object",
      description:
        "The `dimensions` array from an earlier typesafe_review result, to compare directly.",
    },
    sessionID: { type: "string", description: "Optional harness session id." },
  },
  required: [],
  additionalProperties: false,
};

const SKILL_ROUTE_INPUT_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    task: { type: "string", description: "The task or request to route." },
    skills: {
      type: "array",
      description:
        "Candidate skills; each name is an option and each description is its criterion.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name, used as the answer value." },
          description: { type: "string", description: "One line on when this skill applies." },
        },
        required: ["name", "description"],
        additionalProperties: false,
      },
    },
    sessionID: { type: "string", description: "Optional harness session id." },
  },
  required: ["task", "skills"],
  additionalProperties: false,
};

const ASK_DESCRIPTION =
  "Ask TypeSafe/Jev typed questions over a state and get calibrated, structured answers. " +
  "Primitives: choice (pick one of a defined set), noul (probability of yes), score " +
  "(probability-weighted rating across ordered levels). Call before writing any probability, " +
  "ranking, comparison, choice among alternatives, or graded estimate (severity, risk, quality, " +
  "relevance, difficulty); implementation approach is a choice (backend vs frontend, GET vs POST, " +
  "streaming vs in-memory, Java-sort vs SQL-sort) and needs a call before you recommend one. " +
  "Report the answer with its confidence as from Jev, and treat " +
  "confidence below 0.4 as no signal. Every call is logged locally.";

const VERIFY_DESCRIPTION =
  "Verify claims against supplied evidence before publishing them. Code reports which claim " +
  "numbers the evidence does not contain; Jev judges each remaining claim as supported, " +
  "contradicted, unrelated, or insufficient, with confidence. Use for draft answers and " +
  "completion claims. Redacts credentials; never logs the evidence.";

const SKILL_ROUTE_DESCRIPTION =
  "Route a task to one skill from a caller-supplied catalog: Jev picks the skill that fits, " +
  "code applies the confidence and dependence floors, and the answer names the skill to load " +
  "or says none fits. Use when an agent has more skills than it can hold in context. " +
  "The catalog is the caller's; the model cannot choose a candidate that was omitted. " +
  "Task text is redacted and clipped; only the outcome and skill name are logged.";

const REVIEW_DESCRIPTION =
  "Review a change across eight independent quality dimensions (correctness, cognitive " +
  "complexity, readability, modularity, coupling, changeability, test quality, security). " +
  "Each dimension gets an applicability gate and a score; weak dimensions and direct " +
  "before/after directions are returned. There is no blended overall score. Dimensions " +
  "are caller-supplied code, redacted and clipped; scores only are logged.";

const ok = (id: JsonValue, result: JsonValue): string =>
  JSON.stringify({ jsonrpc: "2.0", id, result });

const failure = (id: JsonValue, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

const appendEvent = (
  log: EventLogService | undefined,
  build: (ts: string) => JevEvent,
): Promise<void> =>
  log === undefined
    ? Promise.resolve()
    : Effect.runPromise(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* log.append(build(new Date(now).toISOString()));
        }).pipe(Effect.orElseSucceed(() => undefined)),
      );

const runAsk = async (config: McpConfig, input: AskInput): Promise<McpToolOutcome> => {
  const outcome = await Effect.runPromise(Effect.result(config.ask(input)));
  if (outcome._tag === "Failure") return { ok: false, text: describeJevError(outcome.failure) };
  return { ok: true, text: formatAnswers(outcome.success, input.questions) };
};

const askTool = (config: McpConfig): McpTool => ({
  name: "typesafe_ask",
  title: "TypeSafe Ask",
  description: ASK_DESCRIPTION,
  inputSchema: ASK_INPUT_SCHEMA,
  call: async (args) => {
    const decoded = await Effect.runPromise(Effect.result(decodeAskArgs(args)));
    if (decoded._tag === "Failure") {
      return { ok: false, text: `invalid typesafe_ask arguments: ${decoded.failure.message}` };
    }
    const payload = decoded.success;
    return runAsk(config, {
      harness: config.harness,
      state: payload.state,
      questions: payload.questions,
      model: Option.getOrUndefined(Option.fromNullishOr(payload.model)),
      sessionID: payload.sessionID,
    });
  },
});

const verifyTool = (config: McpConfig): McpTool => ({
  name: "typesafe_verify",
  title: "TypeSafe Verify",
  description: VERIFY_DESCRIPTION,
  inputSchema: VERIFY_INPUT_SCHEMA,
  call: async (args) => {
    const decoded = await Effect.runPromise(Effect.result(decodeVerifyArgs(args)));
    if (decoded._tag === "Failure") {
      return { ok: false, text: `invalid typesafe_verify arguments: ${decoded.failure.message}` };
    }
    const payload = decoded.success;
    if (payload.claims.length === 0) {
      return { ok: false, text: "typesafe_verify needs at least one claim" };
    }
    if (payload.claims.length > MAX_CLAIMS) {
      return { ok: false, text: `typesafe_verify accepts at most ${MAX_CLAIMS} claims per call` };
    }
    if (payload.evidence.length > MAX_EVIDENCE_CHARS) {
      return {
        ok: false,
        text: `evidence exceeds ${MAX_EVIDENCE_CHARS} characters; send a focused excerpt`,
      };
    }
    const claims: ReadonlyArray<EvidenceClaim> = payload.claims.map((claim) => ({
      id: claim.id,
      text: redact(claim.text),
    }));
    const input = { claims, evidence: redact(payload.evidence) };
    const outcome = await Effect.runPromise(
      Effect.result(
        config.ask({
          harness: config.harness,
          state: {
            claims: claims.map((claim) => ({
              id: claim.id,
              text: claim.text,
              missingNumbers: numbersMissingFromEvidence(claim.text, input.evidence),
            })),
            evidence: input.evidence,
          },
          questions: evidenceQuestions(input),
          sessionID: payload.sessionID,
        }),
      ),
    );
    if (outcome._tag === "Failure") return { ok: false, text: describeJevError(outcome.failure) };

    const verdicts = claimVerdicts(outcome.success.answers, input);
    const summary = {
      claims: verdicts.length,
      supported: verdicts.filter((verdict) => verdict.verdict === "supported").length,
      contradicted: verdicts.filter((verdict) => verdict.verdict === "contradicted").length,
      unrelated: verdicts.filter((verdict) => verdict.verdict === "unrelated").length,
      insufficient: verdicts.filter((verdict) => verdict.verdict === "insufficient").length,
      needs_evidence: verdicts.filter((verdict) => verdict.needsEvidence).length,
    };
    await appendEvent(config.log, (ts) => ({
      _tag: "triage",
      ts,
      harness: config.harness,
      sessionID: payload.sessionID,
      feature: "verify",
      summary,
    }));

    const lines = verdicts.map((verdict) => {
      const missing =
        verdict.missingNumbers.length > 0
          ? ` [numbers not in evidence: ${verdict.missingNumbers.join(", ")}]`
          : "";
      const needs = verdict.needsEvidence ? " [needs evidence]" : "";
      return `${verdict.id}: ${verdict.verdict} (confidence ${verdict.confidence})${missing}${needs}`;
    });
    return {
      ok: true,
      text: [
        `jev ${outcome.success.model}`,
        ...lines,
        `usage: ${outcome.success.usage.input} in / ${outcome.success.usage.output} out`,
      ].join("\n"),
    };
  },
});

const reviewTool = (config: McpConfig): McpTool => ({
  name: "typesafe_review",
  title: "TypeSafe Review",
  description: REVIEW_DESCRIPTION,
  inputSchema: REVIEW_INPUT_SCHEMA,
  call: async (args) => {
    const decoded = await Effect.runPromise(Effect.result(decodeReviewArgs(args)));
    if (decoded._tag === "Failure") {
      return { ok: false, text: `invalid typesafe_review arguments: ${decoded.failure.message}` };
    }
    const payload = decoded.success;
    const input = sanitizeReviewInput(payload);
    if (!hasReviewContext(input)) {
      return {
        ok: false,
        text: "typesafe_review needs at least one of task, diff, files, or repositoryContext",
      };
    }
    const stateSize = JSON.stringify(input).length;
    if (stateSize > MAX_REVIEW_STATE_CHARS) {
      return {
        ok: false,
        text: `review state is ${stateSize} characters; review a focused slice (limit ${MAX_REVIEW_STATE_CHARS})`,
      };
    }
    const outcome = await Effect.runPromise(
      Effect.result(
        config.ask({
          harness: config.harness,
          state: input,
          questions: reviewQuestions(input),
          sessionID: payload.sessionID,
        }),
      ),
    );
    if (outcome._tag === "Failure") return { ok: false, text: describeJevError(outcome.failure) };

    const evaluation = evaluateReview(input, outcome.success.answers);
    const dimensions: Record<string, ReviewDimensionResult> = {};
    for (const dimension of evaluation.dimensions) {
      dimensions[dimension.dimension] = {
        applicable: dimension.applicable,
        score: Option.getOrUndefined(
          Option.map(Option.fromUndefinedOr(dimension.score), normalizeReviewScore),
        ),
        confidence: dimension.confidence,
        direction: dimension.direction,
      };
    }
    await appendEvent(config.log, (ts) => ({
      _tag: "review",
      ts,
      harness: config.harness,
      sessionID: payload.sessionID,
      model: outcome.success.model,
      dimensions,
      topWeakness: evaluation.topWeakness,
    }));

    return {
      ok: true,
      text: JSON.stringify(
        {
          model: outcome.success.model,
          dimensions: evaluation.dimensions.map((dimension) => ({
            dimension: dimension.dimension,
            applicable: dimension.applicable,
            score: dimension.score ?? null,
            confidence: dimension.confidence ?? null,
            direction: dimension.direction ?? null,
          })),
          topWeakness: evaluation.topWeakness,
          usage: { input: outcome.success.usage.input, output: outcome.success.usage.output },
        },
        null,
        2,
      ),
    };
  },
});

const skillRouteTool = (config: McpConfig): McpTool => ({
  name: "typesafe_skill_route",
  title: "TypeSafe Skill Route",
  description: SKILL_ROUTE_DESCRIPTION,
  inputSchema: SKILL_ROUTE_INPUT_SCHEMA,
  call: async (args) => {
    const decoded = await Effect.runPromise(Effect.result(decodeSkillRouteArgs(args)));
    if (decoded._tag === "Failure") {
      return {
        ok: false,
        text: `invalid typesafe_skill_route arguments: ${decoded.failure.message}`,
      };
    }
    const payload = decoded.success;
    if (payload.skills.length === 0) {
      return { ok: false, text: "typesafe_skill_route needs at least one candidate skill" };
    }
    if (payload.skills.length > MAX_SKILLS) {
      return {
        ok: false,
        text: `typesafe_skill_route accepts at most ${MAX_SKILLS} candidates per call`,
      };
    }
    const input = {
      task: clip(stripFencedCode(redact(payload.task)), MAX_TASK_CHARS),
      candidates: payload.skills.map((skill) => ({
        name: skill.name,
        description: clip(redact(skill.description), MAX_CRITERION_CHARS),
      })),
    };
    const outcome = await Effect.runPromise(
      Effect.result(
        config.ask({
          harness: config.harness,
          state: {
            task: input.task,
            skills: input.candidates.map((candidate) => ({
              name: candidate.name,
              description: candidate.description,
            })),
          },
          questions: skillRouteQuestions(input),
          sessionID: payload.sessionID,
        }),
      ),
    );
    if (outcome._tag === "Failure") return { ok: false, text: describeJevError(outcome.failure) };

    const route = skillRoute(input, outcome.success.answers);
    await appendEvent(config.log, (ts) => ({
      _tag: "route",
      ts,
      harness: config.harness,
      sessionID: payload.sessionID,
      outcome: route._tag === "routed" ? "routed" : "none",
      reason: route._tag === "routed" ? undefined : route.reason,
      skill: route._tag === "routed" ? route.skill : undefined,
      candidates: input.candidates.length,
      confidence: route.confidence,
      dependence: route.dependence,
    }));

    const decision =
      route._tag === "routed"
        ? `load: ${route.skill}${route.secondNeeded ? " (a second skill likely helps)" : ""}`
        : `load: nothing (${route.reason})`;
    return {
      ok: true,
      text: [
        `jev ${outcome.success.model}`,
        decision,
        `confidence: ${route.confidence}`,
        `dependence: ${route.dependence}`,
        `usage: ${outcome.success.usage.input} in / ${outcome.success.usage.output} out`,
      ].join("\n"),
    };
  },
});

export function createMcpDeps(config: McpConfig): McpDeps {
  return {
    tools: [askTool(config), verifyTool(config), reviewTool(config), skillRouteTool(config)],
  };
}

const initializeResult = (params: Option.Option<JsonValue>, toolNames: string): JsonValue => {
  const protocolVersion = params.pipe(
    Option.flatMap((value) => decodeInitializeParams(value)),
    Option.flatMap((decoded) => Option.fromUndefinedOr(decoded.protocolVersion)),
    Option.getOrElse(() => DEFAULT_PROTOCOL_VERSION),
  );
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "jev", version: SERVER_VERSION },
    instructions: `${CONTEXT_POLICY} Tools: ${toolNames}.`,
  };
};

const toolsCall = async (
  id: JsonValue,
  params: Option.Option<JsonValue>,
  deps: McpDeps,
): Promise<string> => {
  const parsed = Option.flatMap(params, (value) => decodeToolCallParams(value));
  if (Option.isNone(parsed)) return failure(id, -32602, "tools/call requires { name, arguments? }");
  const tool = deps.tools.find((candidate) => candidate.name === parsed.value.name);
  if (tool === undefined) {
    return failure(id, -32602, `unknown tool '${parsed.value.name}'`);
  }
  const args = Option.fromUndefinedOr(parsed.value.arguments).pipe(
    Option.getOrElse((): JsonValue => ({})),
  );
  const result = await tool.call(args);
  if (result.ok) return ok(id, { content: [{ type: "text", text: result.text }] });
  return ok(id, { content: [{ type: "text", text: result.text }], isError: true });
};

export async function handleMcpRequest(line: string, deps: McpDeps): Promise<string | undefined> {
  const request = decodeRequest(line);
  if (Option.isNone(request)) return failure(null, -32700, "parse error");
  const id = Option.fromUndefinedOr(request.value.id).pipe(Option.getOrElse((): JsonValue => null));
  const method = Option.fromUndefinedOr(request.value.method);
  if (Option.isNone(method)) {
    return failure(id, -32600, "invalid request");
  }
  if (request.value.jsonrpc !== "2.0") {
    return failure(id, -32600, "invalid request");
  }
  // Notifications are acknowledgements and take no response.
  if (method.value === "initialized" || method.value.startsWith("notifications/")) {
    return undefined;
  }
  const params = Option.fromUndefinedOr(request.value.params);
  switch (method.value) {
    case "initialize":
      return ok(id, initializeResult(params, deps.tools.map((tool) => tool.name).join(", ")));
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: deps.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: {
            title: tool.title,
            readOnlyHint: true,
            idempotentHint: false,
            openWorldHint: true,
          },
        })),
      });
    case "tools/call":
      return await toolsCall(id, params, deps);
    default:
      return failure(id, -32601, `unknown method '${method.value}'`);
  }
}

/** Serve MCP over a line stream until it closes (stdio by default). */
export async function serveMcp(
  deps: McpDeps,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const lines = createInterface({ input });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    const response = await handleMcpRequest(line, deps);
    if (response !== undefined) output.write(`${response}\n`);
  }
}
