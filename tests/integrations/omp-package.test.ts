import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROMPT_DIRECTIVE } from "../../src/core/directives.ts";
import ompExtension from "../../integrations/omp/index.ts";

type RecallHandler = (event: {
  prompt: string;
  systemPrompt: string;
}) => { systemPrompt?: string } | undefined | void;

const repoRoot = join(import.meta.dirname, "..", "..");

const PackageManifest = Schema.Struct({
  pi: Schema.Struct({
    extensions: Schema.Array(Schema.String),
    skills: Schema.Array(Schema.String),
  }),
});
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(PackageManifest));

describe("omp integration package", () => {
  it("registers the shared prompt-recall handler", () => {
    const handlers = new Map<string, RecallHandler>();
    ompExtension({
      on: (event, handler) => {
        handlers.set(event, handler);
      },
    });
    const handler = handlers.get("before_agent_start");

    expect(handler).toBeDefined();
    const result = handler?.({ prompt: "which option is best, A versus B?", systemPrompt: "base" });
    expect(result).toEqual({ systemPrompt: `base\n\n${PROMPT_DIRECTIVE}` });
    expect(
      handler?.({ prompt: "status: all systems nominal", systemPrompt: "base" }),
    ).toBeUndefined();
  });

  it("points the plugin manifest at the extension and skill it ships", async () => {
    const manifest = decodeManifest(await readFile(join(repoRoot, "package.json"), "utf8"));

    expect(manifest.pi.extensions).toEqual(["./integrations/omp/index.ts"]);
    expect(manifest.pi.skills).toEqual(["./integrations/omp/SKILL.md"]);
    for (const file of [...manifest.pi.extensions, ...manifest.pi.skills]) {
      expect(existsSync(join(repoRoot, file))).toBe(true);
    }
  });
});
