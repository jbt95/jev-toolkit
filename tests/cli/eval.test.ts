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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jev eval pack", () => {
  it("replays labeled fixtures and reports agreement", async () => {
    const path = await tempEventsPath();
    const fixtures = await writeTempFile(
      "fixtures.json",
      JSON.stringify({
        pack: "commit",
        cases: [
          {
            id: "c1",
            input: { message: "feat(parser): add a file" },
            expected: { passed: 1, failed: 0 },
          },
        ],
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["eval", "pack", "--fixtures", fixtures], cliLayers(path, respond)),
    );

    expect(code).toBe(0);
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(printed).toContain("pack commit");
    expect(printed).toContain("agreed=1");
  });

  it("emits the report as JSON with --json and honors --repeat", async () => {
    const path = await tempEventsPath();
    const fixtures = await writeTempFile(
      "fixtures.json",
      JSON.stringify({
        pack: "commit",
        cases: [{ id: "c1", input: { message: "feat(parser): add a file" } }],
      }),
    );
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

  it("prints usage and exits 1 without fixtures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const path = await tempEventsPath();

    const code = await Effect.runPromise(runCli(["eval", "pack"], cliLayers(path, respond)));

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});
