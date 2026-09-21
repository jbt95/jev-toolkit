import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { runCli } from "@/cli/jev.ts";
import {
  apiResponse,
  cliLayers,
  requestQuestionIds,
  tempEventsPath,
  writeTempFile,
  type WireAnswer,
  type WireResponse,
} from "../helpers.ts";

const respond = (body: string): WireResponse => {
  const answers: Record<string, WireAnswer> = {};
  for (const id of requestQuestionIds(body)) {
    answers[id] = { type: "noul", noul: 0.9 };
  }
  return apiResponse(answers);
};

/** One commit-pack fixture; `expected` pins the summary the fake answers produce. */
const commitFixtures = async (expected?: Readonly<Record<string, number>>): Promise<string> => {
  const testCase = {
    id: "c1",
    input: { message: "feat(parser): add a file" },
  };
  return writeTempFile(
    "fixtures.json",
    JSON.stringify({
      pack: "commit",
      cases: [expected === undefined ? testCase : { ...testCase, expected }],
    }),
  );
};

/** A saved pack report for one case, as `jev eval pack --json` writes it. */
const baselineReport = async (
  summary: Readonly<Record<string, number>>,
  agreed: boolean,
): Promise<string> =>
  writeTempFile(
    "baseline.json",
    JSON.stringify({
      pack: "commit",
      model: "jev-1.12",
      repeat: 1,
      cases: [
        {
          id: "c1",
          summary,
          agreed,
          maxSpread: 0,
          unstableAnswers: [],
          inputTokens: 10,
          outputTokens: 2,
          latencyMs: 5,
        },
      ],
      compared: agreed ? 1 : 0,
      agreed: agreed ? 1 : 0,
      inputTokens: 10,
      outputTokens: 2,
      meanLatencyMs: 5,
    }),
  );

const printedLines = (logSpy: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): string =>
  logSpy.mock.calls.map((call) => String(call[0])).join("\n");

/** Run `jev eval pack` with the fake transport and return the exit code and stdout. */
const runEvalPack = async (
  args: ReadonlyArray<string>,
  path: string,
): Promise<{ readonly code: number; readonly printed: string }> => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const code = await Effect.runPromise(runCli(["eval", "pack", ...args], cliLayers(path, respond)));
  return { code, printed: printedLines(logSpy) };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jev eval pack", () => {
  it("replays labeled fixtures and reports agreement", async () => {
    const path = await tempEventsPath();
    const fixtures = await commitFixtures({ passed: 1, failed: 0 });

    const { code, printed } = await runEvalPack(["--fixtures", fixtures], path);

    expect(code).toBe(0);
    expect(printed).toContain("pack commit");
    expect(printed).toContain("agreed=1");
  });

  it("emits the report as JSON with --json and honors --repeat", async () => {
    const path = await tempEventsPath();
    const fixtures = await commitFixtures();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["eval", "pack", "--fixtures", fixtures, "--repeat", "2", "--json"],
        cliLayers(path, respond),
      ),
    );

    expect(code).toBe(0);
    const report = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(report.cases[0].id).toBe("c1");
    expect(report.repeat).toBe(2);
    expect(report.cases[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("fails the run when a baseline regression is present and --fail-on asks for it", async () => {
    const path = await tempEventsPath();
    const fixtures = await commitFixtures({ passed: 0, failed: 1 });
    // The strict baseline says this case passed before; the run now misses it.
    const baseline = await baselineReport({ passed: 1, failed: 0 }, true);

    const { code, printed } = await runEvalPack(
      ["--fixtures", fixtures, "--baseline", baseline, "--fail-on", "regression"],
      path,
    );

    expect(code).toBe(1);
    expect(printed).toContain("regressions: c1");
    expect(printed).toContain("drift: none");
  });

  it("reports drift when the run's answers change for a shared case", async () => {
    const path = await tempEventsPath();
    const fixtures = await commitFixtures({ passed: 1, failed: 0 });
    const baseline = await baselineReport({ passed: 0, failed: 1 }, true);

    const { code, printed } = await runEvalPack(
      ["--fixtures", fixtures, "--baseline", baseline, "--fail-on", "drift"],
      path,
    );

    expect(code).toBe(1);
    expect(printed).toContain("drift: c1/passed 0 -> 1");
  });

  it("passes when the run matches the baseline", async () => {
    const path = await tempEventsPath();
    const fixtures = await commitFixtures({ passed: 1, failed: 0 });
    const baseline = await baselineReport({ passed: 1, failed: 0 }, true);

    const { code, printed } = await runEvalPack(
      ["--fixtures", fixtures, "--baseline", baseline, "--fail-on", "drift"],
      path,
    );

    expect(code).toBe(0);
    expect(printed).toContain("regressions: none");
    expect(printed).toContain("drift: none");
  });

  it("rejects --fail-on without a baseline", async () => {
    const path = await tempEventsPath();
    const fixtures = await commitFixtures();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["eval", "pack", "--fixtures", fixtures, "--fail-on", "regression"],
        cliLayers(path, respond),
      ),
    );

    expect(code).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("--fail-on needs --baseline FILE");
  });

  it("prints usage and exits 1 without fixtures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const path = await tempEventsPath();

    const code = await Effect.runPromise(runCli(["eval", "pack"], cliLayers(path, respond)));

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});
