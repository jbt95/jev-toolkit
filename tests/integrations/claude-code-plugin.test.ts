import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { installFakeJev } from "../helpers.ts";

const pluginDir = join(import.meta.dirname, "..", "..", "integrations", "claude-code");
const promptHook = join(pluginDir, "hooks", "jev-prompt.sh");
const failureHook = join(pluginDir, "hooks", "jev-failure.sh");

const runHook = (script: string, input: string, env: Readonly<Record<string, string>> = {}) => {
  const result = spawnSync("/bin/sh", [script], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { stdout: result.stdout, status: result.status };
};

const PluginManifest = Schema.Struct({
  mcpServers: Schema.Record(
    Schema.String,
    Schema.Struct({
      command: Schema.String,
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
});
const HooksManifest = Schema.Struct({
  hooks: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Struct({ hooks: Schema.Array(Schema.Struct({ command: Schema.String })) })),
  ),
});
const decodePlugin = Schema.decodeUnknownSync(Schema.fromJsonString(PluginManifest));
const decodeHooks = Schema.decodeUnknownSync(Schema.fromJsonString(HooksManifest));

describe("claude-code plugin hooks", () => {
  it("prints the directive that `jev hook prompt` returns", async () => {
    const { binDir, logPath } = await installFakeJev({ "hook prompt": "[Jev policy] test" });

    const result = runHook(promptHook, JSON.stringify({ prompt: "which option is best?" }), {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.stdout).toBe("[Jev policy] test\n");
    expect(result.status).toBe(0);
    expect(await readFile(logPath, "utf8")).toContain("hook prompt");
  });

  it("stays silent and exits zero without jev on PATH", () => {
    const result = runHook(promptHook, JSON.stringify({ prompt: "status: nominal" }), {
      PATH: "/usr/bin:/bin",
    });

    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });

  it("keeps the failure triage only when it blocks work", async () => {
    const path = "/tmp/transcript.jsonl";
    const blocking = await installFakeJev({
      [`triage failure --transcript ${path}`]: "blocks_work: p(yes)=0.9\nclass: flaky test",
    });
    const quiet = await installFakeJev({
      [`triage failure --transcript ${path}`]: "blocks_work: p(yes)=0.2\nclass: typo",
    });

    const blockingOut = runHook(failureHook, JSON.stringify({ transcript_path: path }), {
      PATH: `${blocking.binDir}:${process.env.PATH ?? ""}`,
    });
    const quietOut = runHook(failureHook, JSON.stringify({ transcript_path: path }), {
      PATH: `${quiet.binDir}:${process.env.PATH ?? ""}`,
    });

    expect(blockingOut.stdout).toContain("blocks_work: p(yes)=0.9");
    expect(quietOut.stdout).toBe("");
  });

  it("declares the MCP server and wires both hooks", async () => {
    const plugin = decodePlugin(
      await readFile(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"),
    );
    const hooks = decodeHooks(await readFile(join(pluginDir, "hooks", "hooks.json"), "utf8"));
    const commands = Object.values(hooks.hooks)
      .flat()
      .flatMap((entry) => entry.hooks.map((hook) => hook.command));

    expect(plugin.mcpServers.jev?.command).toBe("jev");
    expect(plugin.mcpServers.jev?.env?.["JEV_HARNESS"]).toBe("claude-code");
    expect(commands).toContain("${CLAUDE_PLUGIN_ROOT}/hooks/jev-prompt.sh");
    expect(commands).toContain("${CLAUDE_PLUGIN_ROOT}/hooks/jev-failure.sh");
  });
});
