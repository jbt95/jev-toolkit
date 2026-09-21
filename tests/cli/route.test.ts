import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@/cli/jev.ts";
import { makeEventLog } from "@/core/events.ts";
import { apiResponse, cliLayers, tempEventsPath, type WireAnswer } from "../helpers.ts";

const skillDir = async (skills: ReadonlyArray<{ dir: string; body: string }>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "jev-skills-"));
  for (const skill of skills) {
    await mkdir(join(root, skill.dir), { recursive: true });
    await writeFile(join(root, skill.dir, "SKILL.md"), skill.body);
  }
  return root;
};

const routed = (choice: string, confidence: number) =>
  ({
    skill: { type: "choice", choice, confidence, probabilities: {} },
    second: { type: "noul", noul: 0.44 },
    dependence: { type: "score", score: 2.4, confidence: 0.6 },
  }) satisfies Readonly<Record<string, WireAnswer>>;

const task = "the export button spins forever; find out why and fix it";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jev route skills", () => {
  it("routes a task to a skill from a directory catalog and logs the decision", async () => {
    const root = await skillDir([
      {
        dir: "debugging",
        body: "---\nname: debugging\ndescription: Systematic root-cause work for failures.\n---\n\n# debugging\n",
      },
      {
        dir: "better-ui",
        body: "---\nname: better-ui\ndescription: UI polish and spacing.\n---\n",
      },
    ]);
    const path = await tempEventsPath();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["route", "skills", "--task", task, "--skills-dir", root, "--json"],
        cliLayers(path, () => apiResponse(routed("debugging", 0.97))),
      ),
    );

    expect(code).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      decision: "routed",
      skill: "debugging",
      confidence: 0.97,
      dependence: 2.4,
      candidates: 2,
    });
    const events = await Effect.runPromise(makeEventLog(path).read());
    const routes = events.filter((event) => event._tag === "route");
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ outcome: "routed", skill: "debugging", candidates: 2 });
  });

  it("declines when the pick is none or the dependence is low", async () => {
    const root = await skillDir([
      { dir: "debugging", body: "---\ndescription: Root-cause work.\n---\n" },
    ]);
    const path = await tempEventsPath();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["route", "skills", "--task", task, "--skills-dir", root, "--json"],
        cliLayers(path, () => apiResponse(routed("none", 0.52))),
      ),
    );

    expect(code).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      decision: "none",
      reason: "no-match",
      skill: null,
    });
    const events = await Effect.runPromise(makeEventLog(path).read());
    expect(events.filter((event) => event._tag === "route")[0]).toMatchObject({ outcome: "none" });
  });

  it("writes no event on a dry run and reads a catalog file", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "jev-skills-")), "catalog.json");
    await writeFile(file, JSON.stringify([{ name: "debugging", description: "Root-cause work." }]));
    const path = await tempEventsPath();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["route", "skills", "--task", task, "--skills", file, "--dry-run"],
        cliLayers(path, () => apiResponse(routed("debugging", 0.9))),
      ),
    );

    expect(code).toBe(0);
    const events = await Effect.runPromise(makeEventLog(path).read());
    expect(events.filter((event) => event._tag === "route")).toEqual([]);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "load: debugging",
    );
  });

  it("requires a task and a catalog, and reports an empty catalog", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const path = await tempEventsPath();

    expect(
      await Effect.runPromise(
        runCli(
          ["route", "skills"],
          cliLayers(path, () => apiResponse({})),
        ),
      ),
    ).toBe(1);
    expect(
      await Effect.runPromise(
        runCli(
          ["route", "skills", "--task", task],
          cliLayers(path, () => apiResponse({})),
        ),
      ),
    ).toBe(1);
    const empty = await mkdtemp(join(tmpdir(), "jev-skills-"));
    expect(
      await Effect.runPromise(
        runCli(
          ["route", "skills", "--task", task, "--skills-dir", empty],
          cliLayers(path, () => apiResponse({})),
        ),
      ),
    ).toBe(1);
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "no skills found",
    );
  });
});
