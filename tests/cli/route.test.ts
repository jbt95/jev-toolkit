import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@/cli/jev.ts";
import { makeEventLog } from "@/core/events.ts";
import {
  apiResponse,
  cliLayers,
  requestQuestionIds,
  tempEventsPath,
  type WireAnswer,
  type WireResponse,
} from "../helpers.ts";

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

/** Two skills, so a follow-up selection has a candidate left to choose. */
const chainSkillsDir = (): Promise<string> =>
  skillDir([
    { dir: "debugging", body: "---\nname: debugging\ndescription: Root-cause work.\n---\n" },
    { dir: "better-ui", body: "---\nname: better-ui\ndescription: UI polish.\n---\n" },
  ]);

/**
 * First call: `debugging` with the second-skill gate open. Follow-up call: the
 * given pick, so a test can push it over or under the floors.
 */
const chainRespond =
  (secondChoice: string, secondConfidence: number, secondDependence: number) =>
  (body: string): WireResponse => {
    if (requestQuestionIds(body).includes("second")) {
      return apiResponse({
        skill: { type: "choice", choice: "debugging", confidence: 0.97, probabilities: {} },
        second: { type: "noul", noul: 0.9 },
        dependence: { type: "score", score: 2.4, confidence: 0.6 },
      });
    }
    return apiResponse({
      skill: {
        type: "choice",
        choice: secondChoice,
        confidence: secondConfidence,
        probabilities: {},
      },
      dependence: { type: "score", score: secondDependence, confidence: 0.7 },
    });
  };

/** Run `jev route skills` against a catalog and return the exit code and JSON decision. */
const runRouteJson = async (
  catalogArgs: ReadonlyArray<string>,
  respond: (body: string) => WireResponse,
): Promise<{ readonly code: number; readonly decision: unknown; readonly path: string }> => {
  const path = await tempEventsPath();
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const code = await Effect.runPromise(
    runCli(["route", "skills", "--task", task, ...catalogArgs, "--json"], cliLayers(path, respond)),
  );
  return { code, decision: JSON.parse(String(logSpy.mock.calls[0]?.[0])), path };
};

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

    const { code, decision, path } = await runRouteJson(["--skills-dir", root], () =>
      apiResponse(routed("debugging", 0.97)),
    );

    expect(code).toBe(0);
    expect(decision).toMatchObject({
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

    const { code, decision, path } = await runRouteJson(["--skills-dir", root], () =>
      apiResponse(routed("none", 0.52)),
    );

    expect(code).toBe(0);
    expect(decision).toMatchObject({ decision: "none", reason: "no-match", skill: null });
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

  it("loads a second skill when the follow-up clears the floors", async () => {
    const root = await chainSkillsDir();

    const { code, decision, path } = await runRouteJson(
      ["--skills-dir", root],
      chainRespond("better-ui", 0.88, 3.1),
    );

    expect(code).toBe(0);
    expect(decision).toMatchObject({
      decision: "routed",
      skill: "debugging",
      skills: ["debugging", "better-ui"],
      second: "better-ui",
    });
    const events = await Effect.runPromise(makeEventLog(path).read());
    const routes = events.filter((event) => event._tag === "route");
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      outcome: "routed",
      skill: "debugging",
      skills: ["debugging", "better-ui"],
    });
  });

  it("keeps the first route and reports a declined follow-up", async () => {
    const root = await chainSkillsDir();

    const { code, decision } = await runRouteJson(
      ["--skills-dir", root],
      chainRespond("better-ui", 0.9, 0.4),
    );

    expect(code).toBe(0);
    expect(decision).toMatchObject({
      skills: ["debugging"],
      second: null,
      secondReason: "low-dependence",
    });
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
