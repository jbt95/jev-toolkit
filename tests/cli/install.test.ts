import { afterEach, describe, expect, it, vi } from "bun:test";
import * as Effect from "effect/Effect";
import { installHarness, type InstallRuntime } from "@/cli/install.ts";
import { joinPath, makeDirectory, readText, removeTree, tempDir, writeText } from "../helpers.ts";

const homes: Array<string> = [];

const runtimeFor = (
  homeDir: string,
  installPiAdapter: InstallRuntime["installPiAdapter"] = () => Effect.succeed(undefined),
  installClaudeMcp: InstallRuntime["installClaudeMcp"] = () => Effect.succeed(undefined),
): InstallRuntime => ({
  homeDir,
  bunPath: "/usr/bin/bun",
  cliEntry: "/work/jev-toolkit/src/cli/jev.ts",
  installPiAdapter,
  installClaudeMcp,
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map(removeTree));
});

describe("harness install", () => {
  it("writes OpenCode's user-level stdio config and harness tag", async () => {
    const home = await tempDir();
    homes.push(home);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(installHarness("opencode", runtimeFor(home)));
    const config = await readText(joinPath(home, ".config", "opencode", "opencode.json"));

    expect(code).toBe(0);
    expect(JSON.parse(config)).toEqual({
      mcp: {
        "jev-toolkit": {
          type: "local",
          command: ["/usr/bin/bun", "/work/jev-toolkit/src/cli/jev.ts", "mcp"],
          environment: { JEV_HARNESS: "opencode" },
        },
      },
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves unrelated OpenCode JSONC settings and updates its entry idempotently", async () => {
    const home = await tempDir();
    homes.push(home);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const path = joinPath(home, ".config", "opencode", "opencode.json");
    const existing = `{
  // user preference
  "theme": "dark",
  /* block comment */
  "label": "literal // and /* comment markers */",
  "mcp": {
    // another server
    "other": { "type": "local", "command": ["echo"] },
  },
}`;
    await makeDirectory(joinPath(home, ".config", "opencode"));
    await writeText(path, existing);

    await Effect.runPromise(installHarness("opencode", runtimeFor(home)));
    const firstInstall = await readText(path);
    await Effect.runPromise(installHarness("opencode", runtimeFor(home)));
    const secondInstall = await readText(path);

    expect(firstInstall).toContain("// user preference");
    expect(firstInstall).toContain("// another server");
    expect(firstInstall).toContain('"theme": "dark"');
    expect(firstInstall).toContain("/* block comment */");
    expect(firstInstall).toContain('"label": "literal // and /* comment markers */"');
    expect(firstInstall).toContain('"other": { "type": "local", "command": ["echo"] }');
    expect(firstInstall.match(/"jev-toolkit"/g)).toHaveLength(1);
    expect(secondInstall).toBe(firstInstall);
  });

  it("installs the Pi adapter and writes the shared user-level MCP config", async () => {
    const home = await tempDir();
    homes.push(home);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const installPiAdapter = vi.fn(() => Effect.succeed(undefined));

    await Effect.runPromise(installHarness("pi", runtimeFor(home, installPiAdapter)));
    const config = await readText(joinPath(home, ".config", "mcp", "mcp.json"));

    expect(installPiAdapter).toHaveBeenCalledTimes(1);
    expect(JSON.parse(config)).toEqual({
      mcpServers: {
        "jev-toolkit": {
          command: "/usr/bin/bun",
          args: ["/work/jev-toolkit/src/cli/jev.ts", "mcp"],
          env: { JEV_HARNESS: "pi" },
        },
      },
    });
  });

  it("writes OMP's user-level stdio config and updates it idempotently", async () => {
    const home = await tempDir();
    homes.push(home);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const path = joinPath(home, ".omp", "agent", "mcp.json");
    await makeDirectory(joinPath(home, ".omp", "agent"));
    await writeText(
      path,
      JSON.stringify({ mcpServers: { other: { type: "stdio", command: "echo" } } }),
    );

    await Effect.runPromise(installHarness("omp", runtimeFor(home)));
    const firstInstall = await readText(path);
    await Effect.runPromise(installHarness("omp", runtimeFor(home)));
    const secondInstall = await readText(path);

    expect(JSON.parse(firstInstall)).toEqual({
      mcpServers: {
        other: { type: "stdio", command: "echo" },
        "jev-toolkit": {
          type: "stdio",
          command: "/usr/bin/bun",
          args: ["/work/jev-toolkit/src/cli/jev.ts", "mcp"],
          env: { JEV_HARNESS: "omp" },
        },
      },
    });
    expect(secondInstall).toBe(firstInstall);
  });

  it("delegates Claude Code registration to its user-scope installer", async () => {
    const home = await tempDir();
    homes.push(home);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const installClaudeMcp = vi.fn(() => Effect.succeed(undefined));

    const code = await Effect.runPromise(
      installHarness("claude-code", runtimeFor(home, undefined, installClaudeMcp)),
    );

    expect(code).toBe(0);
    expect(installClaudeMcp).toHaveBeenCalledTimes(1);
  });

  it("does not alter an invalid config or install the Pi adapter", async () => {
    const home = await tempDir();
    homes.push(home);
    const path = joinPath(home, ".config", "mcp", "mcp.json");
    const invalid = '{ "mcpServers": [ }';
    await makeDirectory(joinPath(home, ".config", "mcp"));
    await writeText(path, invalid);
    const installPiAdapter = vi.fn(() => Effect.succeed(undefined));

    const result = await Effect.runPromise(
      Effect.match(installHarness("pi", runtimeFor(home, installPiAdapter)), {
        onFailure: (error) => `failure: ${error}`,
        onSuccess: () => "success",
      }),
    );

    expect(result).toContain("invalid or incompatible MCP config");
    expect(await readText(path)).toBe(invalid);
    expect(installPiAdapter).not.toHaveBeenCalled();
  });
});
