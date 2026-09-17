import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { runCli } from "@/cli/jev.ts";
import { makeEventLog } from "@/core/events.ts";
import {
  apiResponse,
  cliLayers,
  makeGitRepo,
  requestQuestionIds,
  tempDir,
  tempEventsPath,
  writeTempFile,
  type WireAnswer,
  type WireResponse,
} from "../helpers.ts";

const goodMessage = [
  "feat(parser): reject mixed-indentation blocks",
  "",
  "Mixed tabs and spaces made column math wrong, so blocks now fail",
  "parsing with a clear error. Covered by parser tests.",
].join("\n");

const respond =
  (explanations = 0.9) =>
  (body: string): WireResponse => {
    const answers: Record<string, WireAnswer> = {};
    for (const id of requestQuestionIds(body)) {
      answers[id] = { type: "noul", noul: id === "explains_why" ? explanations : 0.9 };
    }
    return apiResponse(answers);
  };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jev check commit", () => {
  it("passes a conforming message and records a triage event", async () => {
    const file = await writeTempFile("msg.txt", goodMessage);
    const path = await tempEventsPath();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["check", "commit", "--message-file", file], cliLayers(path, respond())),
    );

    expect(code).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("pass: true");
    const events = await Effect.runPromise(makeEventLog(path).read());
    expect(
      events.filter((event) => event._tag === "triage" && event.feature === "commit"),
    ).toHaveLength(1);
  });

  it("fails a message the semantic rules reject", async () => {
    const file = await writeTempFile("msg.txt", goodMessage);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["check", "commit", "--message-file", file],
        cliLayers(await tempEventsPath(), respond(0.2)),
      ),
    );

    expect(code).toBe(1);
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("pass: false");
    expect(output).toContain("failed: explains_why");
  });

  it("uses a documented spec profile when provided", async () => {
    const file = await writeTempFile("msg.txt", goodMessage);
    const spec = await writeTempFile("spec.md", "Commits must link a ticket.");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["check", "commit", "--message-file", file, "--spec", spec],
        cliLayers(await tempEventsPath(), respond()),
      ),
    );

    expect(code).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("pass: true");
  });

  it("fails when the spec file cannot be read", async () => {
    const file = await writeTempFile("msg.txt", goodMessage);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["check", "commit", "--message-file", file, "--spec", "/nonexistent/spec.md"],
        cliLayers(await tempEventsPath(), respond()),
      ),
    );

    expect(code).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("cannot read spec file");
  });

  it("requires a message file outside replay mode", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["check", "commit"], cliLayers(await tempEventsPath(), respond())),
    );

    expect(code).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("usage: jev check commit");
  });

  it("replays recent commits through the judge", async () => {
    const repo = await makeGitRepo();
    const path = await tempEventsPath();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["check", "commit", "--replay", "1", "--repo", repo], cliLayers(path, respond())),
    );

    expect(code).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("pass=true");
    const events = await Effect.runPromise(makeEventLog(path).read());
    expect(events.filter((event) => event._tag === "triage")).toHaveLength(1);
  });

  it("fails replay outside a git repository", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(
        ["check", "commit", "--replay", "1", "--repo", await tempDir()],
        cliLayers(await tempEventsPath(), respond()),
      ),
    );

    expect(code).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("git log failed");
  });

  it("rejects an unknown check subcommand", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["check"], cliLayers(await tempEventsPath(), respond())),
    );

    expect(code).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("usage: jev check commit");
  });
});
