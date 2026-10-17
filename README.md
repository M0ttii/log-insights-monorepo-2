# Log Insights

Log Insights turns the BGL and OpenStack log corpus into **question → evidence →
recommendation** for three roles: engineer, team lead and manager. SereneDB
searches and computes; Claude explains and recommends; every number has a query
receipt.

> **Status:** planning and tooling only. The SereneDB setup, the tool layer, the
> MCP server and the web chat are not implemented yet.

## Requirements

- Node.js 24 (see `.nvmrc`)
- pnpm 11 (pinned via `packageManager`; Corepack picks it up)

## Getting started

```bash
pnpm install
pnpm check
```

## Scripts

| Script | Purpose |
|---|---|
| `pnpm check` | Lint, types, format, architecture rules, unused code, unit tests |

## Superset workspaces

The lifecycle configuration is in [`.superset/config.json`](.superset/config.json).
Once these files are committed and available in the main checkout, create a
workspace in Superset. Setup runs `pnpm install --frozen-lockfile` and copies
untracked `.env*` files from `SUPERSET_ROOT_PATH` at the root and in matching
`apps/*` and `packages/*` directories. Existing files are preserved, tracked
templates are skipped, and packages absent from the workspace are not created.
The gitignored `docs/` directory is also copied if the workspace has none.
Missing optional files are fine; dependency installation failures stop setup.
Copies are independent snapshots, not symlinks or ongoing synchronization.

Click **Run** to launch the `web` dev task through `pnpm dev`. The planned Next.js
server binds to `127.0.0.1` with `--port 0`, letting the OS select a free port even
when workspaces start simultaneously. Open the URL printed in the terminal or
shown in Superset's Ports panel. Stop it from Superset or with Ctrl+C.
**Currently `apps/web` does not exist, so Run exits with an explanatory message.**

Setup starts no background services, so `teardown` is empty. No database,
corpus, receipts, or `node_modules` are copied from the main checkout.
Personal lifecycle additions belong in the gitignored
`.superset/config.local.json`; pair any services started there with teardown.
To rerun setup manually, use
`SUPERSET_ROOT_PATH=/absolute/path/to/main-checkout bash .superset/setup.sh`.
Run `bash .superset/test.sh` for isolated lifecycle checks without installing
dependencies or starting services.

References: [lifecycle scripts](https://docs.superset.sh/setup-teardown-scripts)
and [port management](https://docs.superset.sh/ports).

## Structure

```text
apps/                       applications (none yet; apps/mcp and apps/web are planned)
packages/ui                 shadcn primitives (Base UI), design tokens, cn()
packages/eslint-config      shared ESLint presets
packages/typescript-config  shared tsconfig presets
```

Conventions for contributors and coding agents are in [AGENTS.md](AGENTS.md).
