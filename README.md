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

## Structure

```text
apps/                       applications (none yet; apps/mcp and apps/web are planned)
packages/ui                 shadcn primitives (Base UI), design tokens, cn()
packages/eslint-config      shared ESLint presets
packages/typescript-config  shared tsconfig presets
```

Conventions for contributors and coding agents are in [AGENTS.md](AGENTS.md).
