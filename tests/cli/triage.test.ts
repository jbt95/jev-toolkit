import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { runCli } from "@/cli/jev.ts";
import { makeEventLog } from "@/core/events.ts";
import {
  apiResponse,
  cliLayers,
  requestQuestionIds,
  tempEventsPath,
  writeTempFile,
  type WireAnswer,
  type WireResponse,
} from "../helpers.ts";

const failureAnswers = () =>
  ({
    class: { type: "choice", choice: "env_or_config", confidence: 0.9, probabilities: {} },
    blocks_work: { type: "noul", noul: 0.8 },
    safe_to_suppress: { type: "noul", noul: 0.7 },
  }) satisfies Readonly<Record<string, WireAnswer>>;

const reviewAnswers = () =>
  ({
    f_f1_class: { type: "choice", choice: "blocking", confidence: 0.9, probabilities: {} },
    f_f1_severity: { type: "score", score: 3, confidence: 0.9 },
    f_f1_evidence: { type: "noul", noul: 0.9 },
    review_substantive: { type: "noul", noul: 0.9 },
    truncated: { type: "noul", noul: 0.2 },
  }) satisfies Readonly<Record<string, WireAnswer>>;

const failureRespond =
  (selection = "candidate_1") =>
  (body: string): WireResponse => {
    const ids = requestQuestionIds(body);
    if (ids.includes("failure_index")) {
      return apiResponse({
        failure_index: { type: "choice", choice: selection, confidence: 0.9, probabilities: {} },
      });
    }
    if (ids.includes("same_as")) {
      return apiResponse({
        same_as: { type: "choice", choice: "recent_0", confidence: 0.9, probabilities: {} },
      });
    }
    return apiResponse(failureAnswers());
  };

const failingEntry = (text: string): string =>
  JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", is_error: true, content: [{ type: "text", text }] }],
    },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jev triage", () => {
  it("classifies a failure read from --text", async () => {
    const file = await writeTempFile("failure.txt", "make: cc: No such file or directory");
    const path = await tempEventsPath();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["triage", "failure", "--text", file], cliLayers(path, failureRespond())),
    );

    expect(code).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "failure class: env_or_config",
    );
    expect(
      (await Effect.runPromise(makeEventLog(path).read())).filter(
        (event) => event._tag === "triage" && event.feature === "failure",
      ),
    ).toHaveLength(1);
  });

  it("reads the failure from stdin by default and with --text -", async () => {
    const _logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const layers = cliLayers(await tempEventsPath(), failureRespond());

    const fromDefault = await Effect.runPromise(
      runCli(["triage", "failure"], layers, () => Effect.succeed("boom")),
    );
    const fromDash = await Effect.runPromise(
      runCli(["triage", "failure", "--text", "-"], layers, () => Effect.succeed("boom")),
    );

    expect(fromDefault).toBe(0);
    expect(fromDash).toBe(0);
  });

  it("uses the single candidate from a transcript without a selection call", async () => {
    const file = await writeTempFile("transcript.jsonl", failingEntry("only failure"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["triage", "failure", "--transcript", file],
        cliLayers(await tempEventsPath(), failureRespond()),
      ),
    );

    expect(code).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("failure class:");
  });

  it("asks Jev to select among transcript candidates", async () => {
    const file = await writeTempFile(
      "transcript.jsonl",
      [failingEntry("older failure"), failingEntry("newer failure")].join("\n"),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["triage", "failure", "--transcript", file],
        cliLayers(await tempEventsPath(), failureRespond()),
      ),
    );

    expect(code).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("failure class:");
  });

  it("fails when the transcript has no failing entry", async () => {
    const file = await writeTempFile(
      "transcript.jsonl",
      '{"type":"assistant","message":{"content":[]}}',
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["triage", "failure", "--transcript", file],
        cliLayers(await tempEventsPath(), failureRespond()),
      ),
    );

    expect(code).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("no failing entry found");
  });

  it("fails when the transcript cannot be read", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["triage", "failure", "--transcript", "/nonexistent/transcript.jsonl"],
        cliLayers(await tempEventsPath(), failureRespond()),
      ),
    );

    expect(code).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("cannot read transcript");
  });

  it("routes reviewer findings and records a triage event", async () => {
    const file = await writeTempFile(
      "findings.json",
      JSON.stringify({
        findings: [
          { id: "f1", title: "Missing null check", detail: "Dereference without a check." },
        ],
      }),
    );
    const path = await tempEventsPath();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["triage", "review", "--input", file],
        cliLayers(path, () => apiResponse(reviewAnswers())),
      ),
    );

    expect(code).toBe(0);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain('"blockers"');
    const events = await Effect.runPromise(makeEventLog(path).read());
    expect(
      events.filter((event) => event._tag === "triage" && event.feature === "review"),
    ).toHaveLength(1);
  });

  it("requires --input for review triage", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["triage", "review"],
        cliLayers(await tempEventsPath(), () => apiResponse(reviewAnswers())),
      ),
    );

    expect(code).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("usage: jev triage review");
  });

  it("rejects invalid findings JSON and unreadable files", async () => {
    const invalid = await writeTempFile("findings.json", "not json");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const layers = cliLayers(await tempEventsPath(), () => apiResponse(reviewAnswers()));

    const bad = await Effect.runPromise(runCli(["triage", "review", "--input", invalid], layers));
    const missing = await Effect.runPromise(
      runCli(["triage", "review", "--input", "/nonexistent/findings.json"], layers),
    );

    expect(bad).toBe(1);
    expect(missing).toBe(1);
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "cannot read findings file",
    );
  });

  it("rejects an unknown triage subcommand", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["triage"], cliLayers(await tempEventsPath(), failureRespond())),
    );

    expect(code).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("usage: jev triage failure");
  });
});
