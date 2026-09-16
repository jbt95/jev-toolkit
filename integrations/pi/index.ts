// Native Pi/OMP extension: one tool (`typesafe_ask`) plus a deterministic
// prompt trigger. The extension is a self-contained shim — every judgment
// delegates to the `jev` CLI (`jev ask`, `jev hook prompt`), and it imports
// nothing from the repo. That keeps it loadable through the
// ~/.pi/agent/extensions symlink, where jiti resolves relative paths lexically
// (repo-relative imports do not work) and bare `effect` imports do not resolve.
//
// OMP vendors the Pi extension API and re-exports this file; the harness id
// comes from JEV_HARNESS ("omp" installs set it).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";

const toolResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
});

interface JevRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly detail: string;
}

/** Run the `jev` CLI with stdin JSON; failures never throw. */
const runJev = (
  args: ReadonlyArray<string>,
  input: string,
  harness: string,
): Promise<JevRunResult> =>
  new Promise((resolve) => {
    const child = execFile(
      "jev",
      [...args],
      { maxBuffer: 1024 * 1024, env: { ...process.env, JEV_HARNESS: harness } },
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

export default function jevExtension(pi: ExtensionAPI): void {
  const harness = process.env.JEV_HARNESS === "omp" ? "omp" : "pi";

  pi.registerTool({
    name: "typesafe_ask",
    label: "TypeSafe Ask",
    description:
      "Ask TypeSafe/Jev typed questions over a state and get calibrated, structured answers. " +
      "Primitives: choice (pick one of a defined set), noul (probability of yes), score " +
      "(probability-weighted rating across ordered levels). Use for narrow judgments the code " +
      "path needs: routing, ranking, extraction, verification.",
    promptSnippet:
      "typesafe_ask: calibrated TypeSafe/Jev judgments (choice/noul/score) over a state.",
    promptGuidelines: [
      "Use typesafe_ask before writing any probability, ranking, choice among alternatives, or graded estimate.",
    ],
    parameters: Type.Object({
      state: Type.Unknown({ description: "Text or structured JSON to evaluate." }),
      questions: Type.Unknown({
        description:
          "Map of question id to { _tag: 'choice'|'noul'|'score', instructions, criteria? }.",
      }),
      model: Type.Optional(Type.String({ description: "TypeSafe model, default jev-latest." })),
    }),
    execute: async (_toolCallId, params) => {
      const payload = JSON.stringify({
        state: params.state,
        questions: params.questions,
        model: params.model,
      });
      const result = await runJev(["ask"], payload, harness);
      return toolResult(result.ok ? result.stdout : `jev ask failed: ${result.detail}`);
    },
  });

  pi.on("input", async (event) => {
    const result = await runJev(
      ["hook", "prompt"],
      JSON.stringify({ prompt: event.text }),
      harness,
    );
    const directive = result.stdout.trim();
    if (!result.ok || directive.length === 0) return;
    return { action: "transform", text: `${event.text}\n\n${directive}` };
  });
}
