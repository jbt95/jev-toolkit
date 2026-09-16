// typesafe trigger shim for OpenCode V2.
//
// The `typesafe_ask` tool is served by `jev mcp` — one stdio MCP server for
// every harness (see the README for the `mcp.servers.jev` entry). This plugin
// adds the two deterministic triggers MCP cannot provide: a prompt hook that
// appends the Jev directive when a quantitative question is detected, and a
// context hook that keeps the policy line in every model call.
//
// `@/…` imports resolve through the repo tsconfig (Bun supports tsconfig
// paths); no `effect` imports live here, so the plugin stays dependency-light.
import { Plugin } from "@opencode/plugin";
import { CONTEXT_POLICY, PROMPT_DIRECTIVE } from "@/core/directives.ts";
import { matchQuantitativeClaim } from "@/core/detector.ts";

export default Plugin.define({
  id: "typesafe",
  async setup(ctx) {
    await ctx.session.hook("prompt", (event) => {
      const hits = matchQuantitativeClaim(event.prompt.text);
      if (hits.length > 0) event.prompt.text += `\n\n${PROMPT_DIRECTIVE}`;
    });

    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: CONTEXT_POLICY });
    });
  },
});
