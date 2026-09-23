# jev-toolkit

A small stdio MCP server for TypeSafe/Jev with three tools: `typesafe_ask` for
structured judgments, `typesafe_rank` for ordering supplied candidates by
relevance, and `typesafe_verify` for checking claims against supplied evidence.
Calls use the TypeSafe System One API and are recorded in a local event log.

Built with Effect and TypeSafe's SDK. Bun >= 1.3.14 is required.

## Install

```console
git clone git@github.com:jbt95/jev-toolkit.git
cd jev-toolkit
bun install --frozen-lockfile
scripts/install.sh
export TYPESAFE_API_KEY=…
```

Register Jev in a user-level harness config with:

```console
jev install opencode
jev install pi
jev install omp
jev install claude-code
```

The Pi command installs `pi-mcp-adapter` and requires the Pi CLI and network
access. All commands preserve unrelated MCP settings and set `JEV_HARNESS`
automatically. They do not store `TYPESAFE_API_KEY`; make sure the harness
process provides it to the MCP server. See [docs/mcp.md](docs/mcp.md) for
configuration paths and tool schemas.

## Development

The four gates are:

```console
bun run lint
bun run format:check
bun run typecheck
bun run test
```

The application and CLI run on Bun; the Oxlint `RuleTester` fixture suite uses
Node >= 22.18 because that external test API is Node-only. Tests are offline:
they use fake transports, temporary files, and localhost only. `TYPESAFE_API_KEY`
is read at call time and never logged. Verification
redacts credentials and never writes claim or evidence text to the event log;
rank rejects common code, diff, and transcript patterns, redacts credentials,
and never logs query or candidate text. Its pattern checks are conservative,
not a complete content classifier. Ask state is caller-provided and should be
redacted by the caller.
