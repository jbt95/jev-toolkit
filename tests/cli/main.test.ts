import { afterEach, describe, expect, it, vi } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { runCli, type CliServices } from "@/cli/jev.ts";
import type { InstallRuntime } from "@/cli/install.ts";
import { JevClient, makeJevClient } from "@/core/client.ts";
import { EventLogLive, makeEventLog } from "@/core/events.ts";
import {
  makeTestTransport,
  readText,
  removeTree,
  tempDir,
  tempEventsPath,
  joinPath,
} from "../helpers.ts";

const response = JSON.stringify({
  model: "jev-test",
  answers: { decision: { type: "noul", noul: 0.99 } },
  usage: { input_tokens: 10, output_tokens: 2 },
});

const layersFor = (path: string): Layer.Layer<CliServices> =>
  Layer.mergeAll(
    EventLogLive(path),
    Layer.succeed(
      JevClient,
      makeJevClient({
        apiKey: Option.some("test-key"),
        transport: makeTestTransport(() => Effect.succeed(response)),
        log: makeEventLog(path),
      }),
    ),
  );

const homes: Array<string> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map(removeTree));
});

describe("jev MCP launcher", () => {
  it("rejects the removed ask command and points to the supported commands", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await Effect.runPromise(runCli(["ask"], layersFor(await tempEventsPath())));
    const usage = String(errorSpy.mock.calls[0]?.[0]);

    expect(code).toBe(1);
    expect(usage).toBe("usage: jev mcp | jev install <pi|opencode|omp|claude-code>");
  });

  it("dispatches install commands to the selected user-level harness config", async () => {
    const home = await tempDir();
    homes.push(home);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runtime: InstallRuntime = {
      homeDir: home,
      bunPath: "/usr/bin/bun",
      cliEntry: "/work/jev-toolkit/src/cli/jev.ts",
      installPiAdapter: () => Effect.succeed(undefined),
      installClaudeMcp: () => Effect.succeed(undefined),
    };

    const code = await Effect.runPromise(
      runCli(["install", "opencode"], layersFor(await tempEventsPath()), runtime),
    );
    const config = await readText(joinPath(home, ".config", "opencode", "opencode.json"));

    expect(code).toBe(0);
    expect(config).toContain('"jev-toolkit"');
    expect(config).toContain('"JEV_HARNESS": "opencode"');
  });

  it("dispatches the OMP config and Claude Code registration targets", async () => {
    const home = await tempDir();
    homes.push(home);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const installClaudeMcp = vi.fn(() => Effect.succeed(undefined));
    const runtime: InstallRuntime = {
      homeDir: home,
      bunPath: "/usr/bin/bun",
      cliEntry: "/work/jev-toolkit/src/cli/jev.ts",
      installPiAdapter: () => Effect.succeed(undefined),
      installClaudeMcp,
    };

    const ompCode = await Effect.runPromise(
      runCli(["install", "omp"], layersFor(await tempEventsPath()), runtime),
    );
    const ompConfig = await readText(joinPath(home, ".omp", "agent", "mcp.json"));
    const claudeCode = await Effect.runPromise(
      runCli(["install", "claude-code"], layersFor(await tempEventsPath()), runtime),
    );

    expect(ompCode).toBe(0);
    expect(ompConfig).toContain('"JEV_HARNESS": "omp"');
    expect(claudeCode).toBe(0);
    expect(installClaudeMcp).toHaveBeenCalledTimes(1);
  });
});
