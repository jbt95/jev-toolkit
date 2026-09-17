import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { join } from "node:path";
import { runCli, type CliServices } from "@/cli/jev.ts";
import { JevApiError, JevClient, makeJevClient } from "@/core/client.ts";
import { PROMPT_DIRECTIVE } from "@/core/directives.ts";
import { EventLogLive, makeEventLog } from "@/core/events.ts";
import { LoopGuardLive } from "@/core/loops.ts";
import { apiResponse, cliLayers, makeTestTransport, tempEventsPath } from "../helpers.ts";

const routedYes = () =>
  apiResponse({
    m0_claim: { type: "noul", noul: 0.9 },
    m0_kind: {
      type: "choice",
      choice: "ranking",
      confidence: 0.8,
      probabilities: { ranking: 0.8 },
    },
  });

const routedNo = () =>
  apiResponse({
    m0_claim: { type: "noul", noul: 0.1 },
    m0_kind: { type: "choice", choice: "none", confidence: 0.9, probabilities: { none: 0.9 } },
  });

const failingLayers = async (): Promise<Layer.Layer<CliServices>> => {
  const path = await tempEventsPath();
  return Layer.mergeAll(
    EventLogLive(path),
    LoopGuardLive(join(path, "..", "loop-state.json")),
    Layer.succeed(
      JevClient,
      makeJevClient({
        apiKey: Option.some("test-key"),
        transport: makeTestTransport(() => Effect.fail(new JevApiError({ status: 500 }))),
        log: makeEventLog(path),
      }),
    ),
  );
};

const hookInput =
  (prompt: string): (() => Effect.Effect<string, string>) =>
  () =>
    Effect.succeed(JSON.stringify({ prompt }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jev hook prompt --verify", () => {
  it("prints the directive when Jev confirms a regex hit", async () => {
    const path = await tempEventsPath();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["hook", "prompt", "--verify"],
        cliLayers(path, routedYes),
        hookInput("What are the odds this ships on time?"),
      ),
    );

    expect(code).toBe(0);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain(PROMPT_DIRECTIVE);
  });

  it("stays silent when Jev rejects a regex hit", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["hook", "prompt", "--verify"],
        cliLayers(await tempEventsPath(), routedNo),
        hookInput("What are the odds this ships on time?"),
      ),
    );

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("never calls Jev when the regex misses", async () => {
    const path = await tempEventsPath();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["hook", "prompt", "--verify"],
        cliLayers(path, routedYes),
        hookInput("Fix the failing test."),
      ),
    );

    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
    expect(await Effect.runPromise(makeEventLog(path).read())).toHaveLength(0);
  });

  it("fails open to the directive when Jev is unreachable", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["hook", "prompt", "--verify"],
        await failingLayers(),
        hookInput("What are the odds this ships on time?"),
      ),
    );

    expect(code).toBe(0);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain(PROMPT_DIRECTIVE);
  });

  it("keeps the offline default: no Jev call without --verify", async () => {
    const path = await tempEventsPath();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["hook", "prompt"],
        cliLayers(path, routedNo),
        hookInput("What are the odds this ships on time?"),
      ),
    );

    expect(code).toBe(0);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain(PROMPT_DIRECTIVE);
    expect(await Effect.runPromise(makeEventLog(path).read())).toHaveLength(0);
  });

  it("honors JEV_HOOK_VERIFY=1 without the flag", async () => {
    const previous = process.env.JEV_HOOK_VERIFY;
    process.env.JEV_HOOK_VERIFY = "1";
    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await Effect.runPromise(
        runCli(
          ["hook", "prompt"],
          cliLayers(await tempEventsPath(), routedNo),
          hookInput("What are the odds this ships on time?"),
        ),
      );

      expect(code).toBe(0);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.JEV_HOOK_VERIFY;
      else process.env.JEV_HOOK_VERIFY = previous;
    }
  });
});
