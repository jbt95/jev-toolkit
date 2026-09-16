# jev-toolkit for OpenCode V2

> The V2 plugin API is unstable (written against `@opencode/plugin` 2.0.2).
> Expect breakage across V2 betas; check the
> [V2 plugins guide](https://opencode.ai/v2/docs/build/plugins) when it stops
> loading.

Native plugin with one tool and two deterministic triggers:

- **`typesafe_ask`** — send a `state` plus typed questions (`choice`, `noul`,
  `score`) and get JSON answers with probabilities and confidence. Defaults to
  `jev-latest`.
- **Prompt hook** — appends the Jev directive when a quantitative question is
  detected in your prompt.
- **Context hook** — keeps the one-line policy in every model call.

All calls are logged to `~/.local/share/jev/events.jsonl` and exposed as
Prometheus metrics by `jev meter serve`.

## Install

1. Install dependencies once at the repo root (network required once). The
   plugin and `core/` must share a single `effect` instance, so never install
   inside this folder:
   ```console
   cd ~/personal/jev-toolkit && npm install
   ```
2. Link the directory into the global plugins directory:
   ```console
   rm -rf ~/.config/opencode/plugins/typesafe
   ln -sfn ~/personal/jev-toolkit/integrations/opencode2 ~/.config/opencode/plugins/typesafe
   ```
3. Make sure `opencode.json(c)` lists `./plugins/typesafe/index.ts` in
   `plugins` (file-level entry, not the directory) and that
   `TYPESAFE_API_KEY` is exported where the OpenCode service can see it.
4. Restart the OpenCode service:
   ```console
   opencode2 service restart
   ```
5. Confirm with a real `opencode2 run` tool call; `opencode2 plugin list` does
   not list directory-loaded plugins.

## Notes

- The tool is available to agents and to Code Mode (`tools.typesafe_ask`).
- Tool results declare a string `output` schema plus a text `content` block:
  the V2 code mode runtime reads `output`, so a result without it shows up as
  "no output" even when the tool ran.
- The API key is read at call time from `TYPESAFE_API_KEY`; it is never
  written to configuration or disk by this plugin.
- State sent in a call leaves the machine — keep secrets and raw credentials
  out of `state`.

## Uninstall

Remove the `plugins` entry and the symlink. No other project files are touched.
