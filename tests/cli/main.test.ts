import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { join } from "node:path";
import { runCli, type CliServices } from "@/cli/jev.ts";
import { JevClient, makeJevClient } from "@/core/client.ts";
import { CONTEXT_POLICY } from "@/core/directives.ts";
import { EventLogLive, makeEventLog } from "@/core/events.ts";
import { LoopGuardLive } from "@/core/loops.ts";
import { makeTestTransport, tempEventsPath } from "../helpers.ts";

const cannedSuccess = JSON.stringify({
  model: "jev-1.13.0",
  answers: { is_dupe: { type: "noul", noul: 0.99 } },
  usage: { input_tokens: 100, output_tokens: 10 },
});

const failureResponse = JSON.stringify({
  model: "jev-1.13.0",
  answers: {
    class: {
      type: "choice",
      choice: "env_or_config",
      confidence: 0.9,
      probabilities: { env_or_config: 0.9 },
    },
    blocks_work: { type: "noul", noul: 0.8 },
    safe_to_suppress: { type: "noul", noul: 0.7 },
  },
  usage: { input_tokens: 120, output_tokens: 25 },
});

const layersFor = (path: string, response = cannedSuccess): Layer.Layer<CliServices> =>
  Layer.mergeAll(
    EventLogLive(path),
    LoopGuardLive(join(path, "..", "loop-state.json")),
    Layer.succeed(
      JevClient,
      makeJevClient({
        apiKey: Option.some("test-key"),
        transport: makeTestTransport(() => Effect.succeed(response)),
        log: makeEventLog(path),
      }),
    ),
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jev CLI", () => {
  it("prints recent events as JSON lines", async () => {
    const path = await tempEventsPath();
    await Effect.runPromise(
      makeEventLog(path).append({
        _tag: "opportunity",
        ts: "2026-09-17T00:00:00.000Z",
        harness: "cli",
        source: "assistant_message",
        pattern: "percent",
        matched: false,
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(runCli(["events"], layersFor(path)));

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain('"opportunity"');
  });

  it("prints formatted answers for a valid ask payload", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const input = JSON.stringify({
      state: "My card was charged twice.",
      questions: { is_dupe: { _tag: "noul", instructions: "Duplicate charge?" } },
    });

    const code = await Effect.runPromise(
      runCli(["ask"], layersFor(await tempEventsPath()), () => Effect.succeed(input)),
    );

    expect(code).toBe(0);
    const output = String(logSpy.mock.calls[0]?.[0]);
    expect(output).toContain("p(yes)=0.99");
  });

  it("tolerates a null model in the ask payload", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const input = JSON.stringify({
      state: "text",
      questions: { is_dupe: { _tag: "noul", instructions: "Duplicate charge?" } },
      model: null,
    });

    const code = await Effect.runPromise(
      runCli(["ask"], layersFor(await tempEventsPath()), () => Effect.succeed(input)),
    );

    expect(code).toBe(0);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain("p(yes)=0.99");
  });

  it("prints the Jev directive for a quantitative prompt (hook prompt)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const input = JSON.stringify({ prompt: "What are the odds this ships on time?" });

    const code = await Effect.runPromise(
      runCli(["hook", "prompt"], layersFor(await tempEventsPath()), () => Effect.succeed(input)),
    );

    expect(code).toBe(0);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain("[Jev policy]");
  });

  it("prints the shared policy line for the context hook", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["hook", "context"], layersFor(await tempEventsPath())),
    );

    expect(code).toBe(0);
    expect(String(logSpy.mock.calls[0]?.[0])).toBe(CONTEXT_POLICY);
  });

  it("stays silent for neutral or malformed hook input", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code1 = await Effect.runPromise(
      runCli(["hook", "prompt"], layersFor(await tempEventsPath()), () =>
        Effect.succeed(JSON.stringify({ prompt: "Fix the failing test." })),
      ),
    );
    const code2 = await Effect.runPromise(
      runCli(["hook", "prompt"], layersFor(await tempEventsPath()), () =>
        Effect.succeed("not json"),
      ),
    );

    expect(code1).toBe(0);
    expect(code2).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("classifies failures and escalates only on repeated ones", async () => {
    const path = await tempEventsPath();
    const layers = layersFor(path, failureResponse);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const input = "make: cc: No such file or directory";

    const code1 = await Effect.runPromise(
      runCli(["triage", "failure"], layers, () => Effect.succeed(input)),
    );
    expect(code1).toBe(0);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain("failure class: env_or_config");

    await Effect.runPromise(runCli(["triage", "failure"], layers, () => Effect.succeed(input)));
    await Effect.runPromise(runCli(["triage", "failure"], layers, () => Effect.succeed(input)));

    const allOutput = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(allOutput).toContain("ESCALATE:");
    expect(allOutput).toContain("blocks_work: p(yes)=0.8");

    const events = await Effect.runPromise(makeEventLog(path).read());
    const triageEvents = events.filter((event) => event._tag === "triage");
    expect(triageEvents).toHaveLength(3);
    const last = triageEvents[2];
    if (last?._tag === "triage") {
      expect(last.summary.escalate).toBe(1);
      expect(last.summary.repeats).toBe(3);
    }
  });

  it("fails with exit code 1 on an invalid ask payload", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["ask"], layersFor(await tempEventsPath()), () => Effect.succeed("not json")),
    );

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});
