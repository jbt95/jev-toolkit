import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { runCli } from "@/cli/jev.ts";
import { makeEventLog } from "@/core/events.ts";
import {
  apiResponse,
  cliLayers,
  freePort,
  tempEventsPath,
  waitFor,
  type WireResponse,
} from "../helpers.ts";

const respond = (): WireResponse => apiResponse({ q1: { type: "noul", noul: 0.99 } });

const appendCall = async (path: string, harness: "cli" | "pi"): Promise<void> => {
  await Effect.runPromise(
    makeEventLog(path).append({
      _tag: "call",
      ts: new Date().toISOString(),
      harness,
      model: "jev-test",
      latencyMs: 1,
      status: "ok",
      questions: [{ id: "q1", type: "noul" }],
    }),
  );
};

afterEach(() => {
  delete process.env.JEV_HARNESS;
  delete process.env.JEV_METER_PORT;
  vi.restoreAllMocks();
});

describe("jev CLI surface", () => {
  it("tails events with --n and --harness filters", async () => {
    const path = await tempEventsPath();
    await appendCall(path, "cli");
    await appendCall(path, "pi");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["events", "--n", "1", "--harness", "cli"], cliLayers(path, respond)),
    );

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain('"harness":"cli"');
  });

  it("filters events by type and session and rejects unknown values", async () => {
    const path = await tempEventsPath();
    await appendCall(path, "cli");
    await Effect.runPromise(
      makeEventLog(path).append({
        _tag: "session_label",
        ts: new Date().toISOString(),
        harness: "cli",
        sessionID: "sess-1",
        outcome: "shipped",
        friction: 1,
        waste: "none",
        taskType: "feature",
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const byType = await Effect.runPromise(
      runCli(
        ["events", "--type", "session_label", "--session", "sess-1"],
        cliLayers(path, respond),
      ),
    );
    expect(byType).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain('"_tag":"session_label"');

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const badType = await Effect.runPromise(
      runCli(["events", "--type", "bogus"], cliLayers(path, respond)),
    );
    const badHarness = await Effect.runPromise(
      runCli(["events", "--harness", "bogus"], cliLayers(path, respond)),
    );
    const badSince = await Effect.runPromise(
      runCli(["events", "--since", "yesterday"], cliLayers(path, respond)),
    );

    expect([badType, badHarness, badSince]).toEqual([1, 1, 1]);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("unknown --type: bogus");
    expect(String(errorSpy.mock.calls[1]?.[0])).toContain("unknown harness: bogus");
    expect(String(errorSpy.mock.calls[2]?.[0])).toContain("invalid --since: yesterday");
  });

  it("passes sessionID through ask and falls back on an invalid JEV_HARNESS", async () => {
    const path = await tempEventsPath();
    const input = JSON.stringify({
      state: "text",
      questions: { q1: { _tag: "noul", instructions: "Yes or no?" } },
      sessionID: "ses_attr",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env.JEV_HARNESS = "not-a-harness";

    const code = await Effect.runPromise(
      runCli(["ask"], cliLayers(path, respond), () => Effect.succeed(input)),
    );

    expect(code).toBe(0);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain("p(yes)=0.99");
    const call = (await Effect.runPromise(makeEventLog(path).read())).find(
      (event) => event._tag === "call",
    );
    expect(call?.sessionID).toBe("ses_attr");
    expect(call?.harness).toBe("cli");
  });

  it("rejects unknown hook and meter subcommands", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const layers = cliLayers(await tempEventsPath(), respond);

    const hook = await Effect.runPromise(runCli(["hook"], layers));
    const meter = await Effect.runPromise(runCli(["meter"], layers));

    expect(hook).toBe(1);
    expect(meter).toBe(1);
    const errors = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errors).toContain("usage: jev hook prompt");
    expect(errors).toContain("usage: jev meter serve");
  });

  it("prints usage and exits 1 for an unknown command", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["nope"], cliLayers(await tempEventsPath(), respond)),
    );

    expect(code).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("usage: jev <command>");
  });

  it("exits 1 when stdin cannot be read", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", { value: { isTTY: false }, configurable: true });
    try {
      const code = await Effect.runPromise(
        runCli(["ask"], cliLayers(await tempEventsPath(), respond)),
      );

      expect(code).toBe(1);
    } finally {
      if (stdinDescriptor !== undefined) Object.defineProperty(process, "stdin", stdinDescriptor);
    }
    expect(String(errorSpy.mock.calls[0]?.[0])).toBe("failed to read stdin");
  });

  it("serves metrics on the CLI-selected port", async () => {
    const port = await freePort();
    const fiber = Effect.runFork(
      runCli(
        ["meter", "serve", "--port", String(port)],
        cliLayers(await tempEventsPath(), respond),
      ),
    );
    try {
      const health = await waitFor(`http://127.0.0.1:${port}/health`);
      expect(await health.text()).toBe("ok");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  it("honors JEV_METER_PORT and fails when the port is taken", async () => {
    const port = await freePort();
    process.env.JEV_METER_PORT = String(port);
    const layers = cliLayers(await tempEventsPath(), respond);
    const fiber = Effect.runFork(runCli(["meter", "serve"], layers));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await waitFor(`http://127.0.0.1:${port}/health`);

      const code = await Effect.runPromise(runCli(["meter", "serve"], layers));

      expect(code).toBe(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain("meter failed to start");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });
});
