import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { runCli } from "@/cli/jev.ts";
import { makeEventLog } from "@/core/events.ts";
import { apiResponse, cliLayers, tempEventsPath, type WireResponse } from "../helpers.ts";

const respond = (): WireResponse => apiResponse({ q1: { type: "noul", noul: 0.99 } });

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null) {
        reject(new Error("probe did not bind"));
        return;
      }
      // SAFETY: a TCP server listening on 127.0.0.1 reports an AddressInfo.
      const info = address as AddressInfo;
      probe.close(() => resolve(info.port));
    });
  });

const waitFor = async (url: string): Promise<Response> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`server did not start: ${url}`);
};

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
