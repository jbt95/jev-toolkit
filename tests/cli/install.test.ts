import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "@/cli/jev.ts";
import { apiResponse, cliLayers, tempDir, tempEventsPath } from "../helpers.ts";

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  vi.restoreAllMocks();
});

describe("jev install", () => {
  it("installs the OpenCode files and preserves config entries idempotently", async () => {
    const root = await tempDir();
    const configHome = join(root, "config");
    const opencodeDir = join(configHome, "opencode");
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      join(opencodeDir, "opencode.json"),
      JSON.stringify({
        model: "test/model",
        plugins: ["other-plugin", { package: "configured-plugin", options: { enabled: true } }],
        instructions: ["AGENTS.md"],
      }),
    );
    process.env.XDG_CONFIG_HOME = configHome;
    const logPath = await tempEventsPath();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const first = await Effect.runPromise(
      runCli(
        ["install", "opencode"],
        cliLayers(logPath, () => apiResponse({})),
      ),
    );
    const second = await Effect.runPromise(
      runCli(
        ["install", "opencode"],
        cliLayers(logPath, () => apiResponse({})),
      ),
    );

    expect(first).toBe(0);
    expect(second).toBe(0);
    const config = await readFile(join(opencodeDir, "opencode.json"), "utf8");
    expect(config).toContain('"model": "test/model"');
    expect(config.match(/\.\/plugins\/jev\/index\.ts/g)).toHaveLength(1);
    expect(config.match(/instructions\/jev-routing\.md/g)).toHaveLength(1);
    expect(await readFile(join(opencodeDir, "plugins", "jev", "index.ts"), "utf8")).toContain(
      "typesafe_skill_route",
    );
    expect(await readFile(join(opencodeDir, "instructions", "jev-routing.md"), "utf8")).toContain(
      "typesafe_skill_route",
    );
  });

  it("does not overwrite a custom managed file without --force", async () => {
    const root = await tempDir();
    const configHome = join(root, "config");
    const pluginDir = join(configHome, "opencode", "plugins", "jev");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "index.ts"), "// custom plugin\n");
    process.env.XDG_CONFIG_HOME = configHome;
    const logPath = await tempEventsPath();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const refused = await Effect.runPromise(
      runCli(
        ["install", "opencode"],
        cliLayers(logPath, () => apiResponse({})),
      ),
    );
    const forced = await Effect.runPromise(
      runCli(
        ["install", "opencode", "--force"],
        cliLayers(logPath, () => apiResponse({})),
      ),
    );

    expect(refused).toBe(1);
    expect(forced).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--force"));
    expect(await readFile(join(pluginDir, "index.ts"), "utf8")).toContain("typesafe_skill_route");
  });

  it("reads JSONC comments without changing comment-like strings", async () => {
    const root = await tempDir();
    const configHome = join(root, "config");
    const opencodeDir = join(configHome, "opencode");
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      join(opencodeDir, "opencode.jsonc"),
      `{
        // A line comment.
        "endpoint": "https://example.test/a//b",
        "literal": "/* keep this text */",
        "plugins": ["other-plugin",],
        "instructions": ["AGENTS.md", /* A block comment. */],
      }`,
    );
    process.env.XDG_CONFIG_HOME = configHome;
    const logPath = await tempEventsPath();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await Effect.runPromise(
      runCli(
        ["install", "opencode"],
        cliLayers(logPath, () => apiResponse({})),
      ),
    );

    expect(result).toBe(0);
    const config = JSON.parse(await readFile(join(opencodeDir, "opencode.jsonc"), "utf8"));
    expect(config.endpoint).toBe("https://example.test/a//b");
    expect(config.literal).toBe("/* keep this text */");
  });
});
