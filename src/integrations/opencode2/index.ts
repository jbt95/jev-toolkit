// typesafe trigger shim for OpenCode V2.
//
// The `typesafe_ask` tool is served by `jev mcp` — one stdio MCP server for
// every harness (see the README for the `mcp.servers.jev` entry). This plugin
// adds the two deterministic triggers MCP cannot provide: a prompt hook that
// appends the Jev directive when a quantitative question is detected, and a
// context hook that keeps the policy line in every model call.
//
// The plugin imports nothing from the repo on purpose. OpenCode loads it
// through the ~/.config/opencode/plugins/typesafe symlink, and the Bun loader
// resolves relative specifiers against the link path (`../../core/…` becomes
// ~/.config/opencode/core/… and fails; verified 2026-09-17). Everything shared
// comes from the `jev` CLI instead: `hook prompt` for detection and
// `hook context` for the policy line. `@opencode/plugin` resolves from this
// directory's node_modules (bun install here); `effect` never enters the
// plugin, so the repo keeps a single `effect` instance.
import { Plugin } from "@opencode/plugin";
import { execFile } from "node:child_process";

/** Hook calls are local CLI work; kill a hung process instead of blocking prompts. */
const HOOK_TIMEOUT_MS = 10_000;
/** Triage may call the API (120s timeout); kill it instead of accumulating stuck children. */
const TRIAGE_TIMEOUT_MS = 130_000;

interface JevRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly detail: string;
}

/** Run the `jev` CLI with stdin JSON; failures never throw. */
const runJev = (
  args: ReadonlyArray<string>,
  input: string,
  timeoutMs: number,
): Promise<JevRunResult> =>
  new Promise((resolve) => {
    const child = execFile(
      "jev",
      [...args],
      {
        maxBuffer: 1024 * 1024,
        timeout: timeoutMs,
        env: { ...process.env, JEV_HARNESS: "opencode2" },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = stderr.trim().length > 0 ? stderr.trim() : error.message;
          resolve({ ok: false, stdout: "", detail });
          return;
        }
        resolve({ ok: true, stdout, detail: "" });
      },
    );
    child.stdin?.end(input);
  });

/** Best-effort failure triage via the CLI; never blocks or throws. */
const triageFailure = (text: string): void => {
  void runJev(["triage", "failure"], text.slice(0, 4000), TRIAGE_TIMEOUT_MS);
};

export default Plugin.define({
  id: "typesafe",
  async setup(ctx) {
    // Fetch the shared policy line once; the context hook runs per model call.
    const policy = await runJev(["hook", "context"], "", HOOK_TIMEOUT_MS);
    if (!policy.ok) {
      console.warn(`typesafe plugin: jev hook context failed: ${policy.detail}`);
    }
    const contextPolicy = policy.ok ? policy.stdout.trim() : "";

    await ctx.session.hook("prompt", async (event) => {
      const result = await runJev(
        ["hook", "prompt"],
        JSON.stringify({ prompt: event.prompt.text }),
        HOOK_TIMEOUT_MS,
      );
      const directive = result.stdout.trim();
      if (!result.ok || directive.length === 0) return;
      event.prompt.text += `\n\n${directive}`;
    });

    await ctx.session.hook("context", (event) => {
      if (contextPolicy.length === 0) return;
      event.system.push({ type: "text", text: contextPolicy });
    });

    await ctx.tool.hook("execute.after", (event) => {
      if (event.status === "error") triageFailure(event.error.message);
    });
  },
});
