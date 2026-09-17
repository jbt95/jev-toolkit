import { afterEach, describe, expect, it, vi } from "vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";
import plugin from "@/integrations/opencode2/index.ts";
import {
  installFakeJev,
  tempDir,
  waitForFileContains,
  withIsolatedPath,
  withPath,
} from "../helpers.ts";

interface TranscriptPart {
  readonly type: string;
  readonly text?: string;
}

interface TranscriptMessage {
  readonly role: string;
  readonly content: ReadonlyArray<TranscriptPart>;
}

interface ContextEvent {
  readonly sessionID: string;
  readonly system: Array<{ readonly type: "text"; readonly text: string }>;
  readonly messages: ReadonlyArray<TranscriptMessage>;
}

interface ToolEvent {
  readonly status: string;
  readonly error: { readonly message: string };
}

type ContextHandler = (event: ContextEvent) => void | Promise<void>;
type ToolHandler = (event: ToolEvent) => void;

interface HookRegistry<Handler> {
  readonly hook: (name: string, handler: Handler) => Promise<void>;
}

interface PluginContext {
  readonly session: HookRegistry<ContextHandler>;
  readonly tool: HookRegistry<ToolHandler>;
}

type Setup = (context: PluginContext) => Promise<void> | void;

// Decode the module boundary rather than asserting it; the plugin only reads
// the session and tool hook registries from the context.
const PluginModule = Schema.Struct({
  setup: Schema.declare<Setup>((value: unknown): value is Setup => value !== null),
});
const decodePlugin = Schema.decodeUnknownOption(PluginModule);

interface Hooks {
  readonly context: ContextHandler;
  readonly tool: ToolHandler;
}

/** Run the plugin's setup against a fake context and capture its hooks. */
const setup = async (): Promise<Hooks> => {
  const contextHandlers = new Map<string, ContextHandler>();
  const toolHandlers = new Map<string, ToolHandler>();
  const context: PluginContext = {
    session: {
      hook: (name, handler) => {
        contextHandlers.set(name, handler);
        return Promise.resolve();
      },
    },
    tool: {
      hook: (name, handler) => {
        toolHandlers.set(name, handler);
        return Promise.resolve();
      },
    },
  };
  const decoded = decodePlugin(plugin);
  if (Option.isNone(decoded)) throw new Error("opencode2 plugin shape");
  await decoded.value.setup(context);
  const contextHook = contextHandlers.get("context");
  const toolHook = toolHandlers.get("execute.after");
  if (contextHook === undefined || toolHook === undefined) throw new Error("hooks missing");
  return { context: contextHook, tool: toolHook };
};

const contextEvent = (text: string): ContextEvent => ({
  sessionID: "ses_plugin",
  system: [],
  messages: [
    { role: "assistant", content: [{ type: "text", text: "ready" }] },
    { role: "user", content: [{ type: "text", text }] },
  ],
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("opencode2 plugin", () => {
  it("injects the policy, the session id, and the directive, caching per prompt", async () => {
    const { binDir, logPath } = await installFakeJev({
      "hook context": "POLICY",
      "hook prompt": "DIRECTIVE",
    });

    await withPath(binDir, async () => {
      const hooks = await setup();
      const event = contextEvent("Should we ship now?");
      await hooks.context(event);
      const texts = event.system.map((part) => part.text);
      expect(texts).toContain("POLICY");
      expect(texts.some((text) => text.includes('sessionID: "ses_plugin"'))).toBe(true);
      expect(texts).toContain("DIRECTIVE");

      // Tool-driven continuation: the same prompt is cached, so no second CLI run.
      await hooks.context(event);
      const followUp: ContextEvent = {
        ...event,
        messages: [
          ...event.messages,
          { role: "user", content: [{ type: "text", text: "unrelated follow-up" }] },
        ],
      };
      await hooks.context(followUp);
    });

    const log = await readFile(logPath, "utf8");
    expect(log.match(/hook prompt/g)).toHaveLength(2);
  });

  it("skips detection when the transcript has no user message", async () => {
    const { binDir, logPath } = await installFakeJev({
      "hook context": "POLICY",
      "hook prompt": "DIRECTIVE",
    });

    await withPath(binDir, async () => {
      const hooks = await setup();
      const event: ContextEvent = {
        sessionID: "ses_plugin",
        system: [],
        messages: [{ role: "assistant", content: [{ type: "text", text: "ready" }] }],
      };
      await hooks.context(event);
      expect(event.system.some((part) => part.text === "DIRECTIVE")).toBe(false);
    });

    expect(await readFile(logPath, "utf8")).not.toContain("hook prompt");
  });

  it("warns and omits the policy when the CLI is unavailable", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await withIsolatedPath(await tempDir(), async () => {
      const hooks = await setup();
      const event = contextEvent("Should we ship now?");
      await hooks.context(event);
      const texts = event.system.map((part) => part.text).join("\n");
      expect(texts).not.toContain("POLICY");
      expect(texts).toContain("Jev session: ses_plugin");
    });

    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("typesafe plugin");
  });

  it("triages tool errors best-effort and ignores clean results", async () => {
    const { binDir, logPath } = await installFakeJev({
      "hook context": "POLICY",
      "triage failure": "",
    });

    await withPath(binDir, async () => {
      const hooks = await setup();
      hooks.tool({ status: "ok", error: { message: "none" } });
      hooks.tool({ status: "error", error: { message: "boom" } });
      expect(await waitForFileContains(logPath, "triage failure")).toBe(true);
    });

    expect((await readFile(logPath, "utf8")).match(/triage failure/g)).toHaveLength(1);
  });
});
