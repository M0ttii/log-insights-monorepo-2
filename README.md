# Log Insights

Log Insights turns the BGL and OpenStack log corpus into **question → evidence →
recommendation** for three roles: engineer, team lead and manager. SereneDB
searches and computes; Claude explains and recommends; every number has a query
receipt.

> **Status:** SereneDB runs via Docker Compose and passed the compatibility
> gate (`pnpm gate`). The loader, the tool layer, the MCP server and the web
> chat are not implemented yet.

## Requirements

- Node.js 24 (see `.nvmrc`)
- pnpm 11 (pinned via `packageManager`; Corepack picks it up)
- Docker with Compose (SereneDB only)

## Getting started

```bash
pnpm install
pnpm check

cp .env.example .env            # then set SERENEDB_PASSWORD, e.g. openssl rand -hex 16
docker compose up -d --wait     # SereneDB on 127.0.0.1:7890 only
```

The password seeds the SereneDB superuser when its data volume is first
created; to change it later, run `ALTER ROLE` or recreate the volume
(`docker compose down -v`, which deletes all loaded data).

## Scripts

| Script | Purpose |
|---|---|
| `pnpm check` | Lint, types, format, architecture rules, unused code, unit tests |
| `pnpm gate [G1 …] [--keep]` | SereneDB compatibility gate (technical spec § 5.2) against the running container; full-corpus probes need `.data/raw/BGL.log` and are skipped without it |

## Structure

```text
apps/                       applications (none yet; apps/mcp and apps/web are planned)
packages/corpus             SereneDB gate probes; later the loader
packages/ui                 shadcn primitives (Base UI), design tokens, cn()
packages/eslint-config      shared ESLint presets
packages/typescript-config  shared tsconfig presets
```

Conventions for contributors and coding agents are in [AGENTS.md](AGENTS.md).
