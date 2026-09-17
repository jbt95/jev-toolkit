import { afterEach, describe, expect, it, vi } from "vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";
import * as piModule from "@/integrations/pi/index.ts";
import { installFailingJev, installFakeJev, waitForFileContains, withPath } from "../helpers.ts";

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;

interface ToolParams {
  readonly state: JsonValue;
  readonly questions: JsonValue;
  readonly model?: string;
}

interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
}

interface ToolDefinition {
  readonly name: string;
  readonly execute: (id: string, params: ToolParams) => Promise<ToolResult>;
}

type InputResult = { readonly action: "transform"; readonly text: string } | undefined;
type InputHandler = (event: { readonly text: string }) => InputResult | Promise<InputResult>;
type ToolResultHandler = (event: { readonly isError: boolean; readonly content: string }) => void;

interface PiApi {
  readonly registerTool: (definition: ToolDefinition) => void;
  readonly on: (name: string, handler: InputHandler | ToolResultHandler) => void;
}

type Extension = (pi: PiApi) => void;

// The module boundary is decoded instead of asserted; the extension only uses
// registerTool and on, so the declared shape is exactly what the test drives.
const ExtensionModule = Schema.Struct({
  default: Schema.declare<Extension>((value: unknown): value is Extension => value !== null),
});
const decodeExtension = Schema.decodeUnknownOption(ExtensionModule);

interface Harness {
  readonly tool: ToolDefinition;
  readonly input: InputHandler;
  readonly toolResult: ToolResultHandler;
}

/** Drive the extension through a fake Pi API, capturing its registrations. */
const loadHarness = (): Harness => {
  let tool: ToolDefinition | undefined;
  let input: InputHandler | undefined;
  let toolResult: ToolResultHandler | undefined;
  const fake: PiApi = {
    registerTool: (definition) => {
      tool = definition;
    },
    on: (name, handler) => {
      if (name === "input") {
        // SAFETY: the name selects which handler kind the extension registered.
        input = handler as InputHandler;
        return;
      }
      // SAFETY: the other registration is the tool_result handler.
      toolResult = handler as ToolResultHandler;
    },
  };
  const decoded = decodeExtension(piModule);
  if (Option.isNone(decoded)) throw new Error("pi extension shape");
  decoded.value.default(fake);
  if (tool === undefined || input === undefined || toolResult === undefined) {
    throw new Error("extension did not register the expected hooks");
  }
  return { tool, input, toolResult };
};

afterEach(() => {
  delete process.env.JEV_HARNESS;
  delete process.env.OMPCODE;
  vi.restoreAllMocks();
});

describe("pi/omp extension", () => {
  it("delegates typesafe_ask to the jev CLI with the detected harness", async () => {
    const { binDir, logPath } = await installFakeJev({ ask: "jev test\nq1: p(yes)=0.99" });
    process.env.JEV_HARNESS = "pi";

    await withPath(binDir, async () => {
      const harness = loadHarness();
      const result = await harness.tool.execute("call-1", {
        state: "text",
        questions: { q1: { _tag: "noul" } },
      });

      expect(result.content[0]?.text).toContain("p(yes)=0.99");
    });

    expect(await readFile(logPath, "utf8")).toContain("pi ask");
  });

  it("detects omp from JEV_HARNESS and from OMPCODE", async () => {
    const { binDir, logPath } = await installFakeJev({ ask: "ok" });

    await withPath(binDir, async () => {
      process.env.JEV_HARNESS = "omp";
      await loadHarness().tool.execute("call-2", { state: "x", questions: {} });
      delete process.env.JEV_HARNESS;
      process.env.OMPCODE = "1";
      await loadHarness().tool.execute("call-3", { state: "x", questions: {} });
    });

    const log = await readFile(logPath, "utf8");
    expect(log.match(/omp ask/g)).toHaveLength(2);
  });

  it("reports a CLI failure instead of inventing an answer", async () => {
    const { binDir } = await installFailingJev();
    process.env.JEV_HARNESS = "pi";

    await withPath(binDir, async () => {
      const result = await loadHarness().tool.execute("call-4", { state: "x", questions: {} });
      expect(result.content[0]?.text).toContain("jev ask failed");
    });
  });

  it("transforms the prompt when the directive applies and stays silent otherwise", async () => {
    const withDirective = await installFakeJev({ "hook prompt": "DIRECTIVE" });
    const withoutDirective = await installFakeJev({});
    process.env.JEV_HARNESS = "pi";

    await withPath(withDirective.binDir, async () => {
      const result = await loadHarness().input({ text: "What are the odds?" });
      expect(result).toEqual({ action: "transform", text: "What are the odds?\n\nDIRECTIVE" });
    });
    await withPath(withoutDirective.binDir, async () => {
      expect(await loadHarness().input({ text: "Fix the test." })).toBeUndefined();
    });
  });

  it("re-exports the same extension for omp", async () => {
    const omp = await import("@/integrations/omp/index.ts");
    expect(omp.default).toBe(piModule.default);
  });

  it("triages tool errors best-effort but ignores clean results", async () => {
    const { binDir, logPath } = await installFakeJev({});
    process.env.JEV_HARNESS = "pi";

    await withPath(binDir, async () => {
      const harness = loadHarness();
      harness.toolResult({ isError: false, content: "clean" });
      harness.toolResult({ isError: true, content: "boom" });
      expect(await waitForFileContains(logPath, "triage failure")).toBe(true);
    });

    const log = await readFile(logPath, "utf8");
    expect(log.match(/triage failure/g)).toHaveLength(1);
  });
});
