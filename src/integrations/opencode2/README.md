# jev-toolkit for OpenCode V2

> The V2 plugin API is unstable (written against `@opencode/plugin` 2.0.2).
> Expect breakage across V2 betas; check the
> [V2 plugins guide](https://opencode.ai/v2/docs/build/plugins) when it stops
> loading.

Two parts, split by what each can do:

- **Tool** — served by `jev mcp` (the single stdio MCP server shared by every
  harness); OpenCode connects through `mcp.servers.jev`.
- **Triggers** — this plugin (hooks only): a context hook that appends the Jev
  directive when the latest prompt asks for a quantitative judgment and keeps
  the policy line in every model call. MCP cannot do either. The V2 beta
  (`0.0.0-beta-18269`) accepts a `prompt` hook registration but never
  dispatches it (verified 2026-09-17), so the context hook carries both. The
  same hook injects the session id and asks the model to pass it as `sessionID`
  in each `typesafe_ask` call, keeping MCP calls attributable for the audit and
  the impact metrics.

## Install the MCP tool

Add to the global `opencode.json(c)`:

```jsonc
{
  "mcp": {
    "servers": {
      "jev": {
        "type": "local",
        "command": ["jev", "mcp"],
        "environment": { "JEV_HARNESS": "opencode2" },
      },
    },
  },
}
```

`jev` must be on `PATH` (see `~/personal/jev-toolkit/scripts/install.sh`).

## Install the trigger plugin

1. Install the plugin dependency (network required once). The plugin loads
   through the `~/.config/opencode/plugins/typesafe` symlink, so its bare
   `@opencode/plugin` import resolves from this directory. The plugin imports
   nothing else from the repo: it shells out to the `jev` CLI (`hook prompt`,
   `hook context`, `triage failure`), so `jev` must be on `PATH` (see
   `scripts/install.sh`). Relative repo imports do **not** work here — the Bun
   loader resolves them against the link path, so `../../core/…` looks for
   `~/.config/opencode/core/…`:
   ```console
   cd ~/personal/jev-toolkit/src/integrations/opencode2 && bun install
   ```
2. Link the plugin directory:
   ```console
   rm -rf ~/.config/opencode/plugins/typesafe
   ln -sfn ~/personal/jev-toolkit/src/integrations/opencode2 ~/.config/opencode/plugins/typesafe
   ```
3. Ensure `opencode.json(c)` lists `./plugins/typesafe/index.ts` in `plugins`
   (file-level entry, not the directory) and that `TYPESAFE_API_KEY` is
   exported where the OpenCode service can see it.
4. Restart the shared service so both the plugin and the MCP server load:
   ```console
   opencode2 service restart
   ```

## Notes

- MCP tools appear through Code Mode (`tools.jev_typesafe_ask`) when `codemode`
  is enabled (the default).
- Never register both a native tool and the MCP tool for the same capability —
  duplicate names shadow each other.
- `TYPESAFE_API_KEY` is read at call time by the MCP server process; it is
  never written to configuration or disk by this repo.
- State sent in a call leaves the machine — keep secrets and raw credentials
  out of `state`.

## Uninstall

Remove the `plugins` entry, the `mcp.servers.jev` entry, and the symlink. No
other project files are touched.
