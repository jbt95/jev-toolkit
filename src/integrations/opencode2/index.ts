// typesafe trigger shim for OpenCode V2.
//
// The `typesafe_ask` tool is served by `jev mcp` — one stdio MCP server for
// every harness (see the README for the `mcp.servers.jev` entry). This plugin
// adds the two deterministic triggers MCP cannot provide: directive injection
// when the latest prompt asks for a quantitative judgment, and failure triage
// on tool errors. The context hook also hands the model the exact session id so
// MCP calls can be attributed back to the session (see below).
//
// Trigger shape: beta 0.0.0-beta-18269 accepts a `prompt` hook registration but
// never dispatches it (verified 2026-09-17 with a minimal probe plugin —
// `context` and `execute.after` fire, `prompt` does not). Directive injection
// therefore lives in the `context` hook, which runs before every model call:
// the latest user message is re-checked through `jev hook prompt` and the
// directive is pushed into the system parts. The check is cached per prompt so
// tool-driven continuations do not re-run the CLI.
//
// MCP cannot carry a session id, so the context hook also injects the session
// id with instructions to pass it as `sessionID` in every typesafe_ask call;
// the audit uses that to align detected claims with the questions asked.
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

/** Minimal structural view of the SDK transcript; the shim imports no SDK types. */
interface TranscriptPart {
  readonly type: string;
  readonly text?: string | null;
}

interface TranscriptMessage {
  readonly role: string;
  readonly content: ReadonlyArray<TranscriptPart>;
}

/** Latest user message text in the assembled transcript; empty when there is none. */
const latestUserText = (messages: ReadonlyArray<TranscriptMessage>): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "user") continue;
    return message.content
      .flatMap((part) =>
        part.type === "text" && part.text !== undefined && part.text !== null ? [part.text] : [],
      )
      .join("\n");
  }
  return "";
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

    // One CLI run per prompt; tool continuations reuse the cached directive.
    let cachedPrompt = "";
    let cachedDirective = "";

    const directiveFor = async (sessionID: string, prompt: string): Promise<string> => {
      const key = `${sessionID}\u0000${prompt}`;
      if (key === cachedPrompt) return cachedDirective;
      cachedPrompt = key;
      cachedDirective = "";
      if (prompt.length === 0) return "";
      const result = await runJev(["hook", "prompt"], JSON.stringify({ prompt }), HOOK_TIMEOUT_MS);
      if (!result.ok) return "";
      cachedDirective = result.stdout.trim();
      return cachedDirective;
    };

    await ctx.session.hook("context", async (event) => {
      if (contextPolicy.length > 0) {
        event.system.push({ type: "text", text: contextPolicy });
      }
      // Attribution: the MCP transport cannot carry the session id, so hand the
      // model the exact value to pass back with each typesafe_ask call.
      event.system.push({
        type: "text",
        text:
          `Jev session: ${event.sessionID}. ` +
          `Include sessionID: "${event.sessionID}" in every typesafe_ask call so the ` +
          "judgment is attributed to this session; never invent a session id.",
      });
      const directive = await directiveFor(event.sessionID, latestUserText(event.messages));
      if (directive.length > 0) {
        event.system.push({ type: "text", text: directive });
      }
    });

    await ctx.tool.hook("execute.after", (event) => {
      if (event.status === "error") triageFailure(event.error.message);
    });
  },
});
