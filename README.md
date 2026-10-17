# Log Insights

Log Insights turns the BGL and OpenStack log corpus into **question → evidence →
recommendation** for three roles: engineer, team lead and manager. SereneDB
searches and computes; Claude explains and recommends; every number has a query
receipt.

> **Status:** SereneDB runs via Docker Compose and passed the compatibility
> gate (`pnpm gate`); `pnpm data:setup` loads the corpus, and the data
> decisions below come from profiling it (`pnpm data:profile`). Two of the
> eight tools exist (`describe_corpus`, `search_logs`); the other tools, the
> MCP server and the web chat are not implemented yet.

## Requirements

- Node.js 24 (see `.nvmrc`)
- pnpm 11 (pinned via `packageManager`; Corepack picks it up)
- Docker with Compose (SereneDB only)

## Getting started

```bash
pnpm install
pnpm check

cp .env.example .env            # then set SERENEDB_PASSWORD, e.g. openssl rand -hex 16
pnpm data:setup                 # starts SereneDB, downloads and loads the corpus
```

`pnpm data:setup` starts SereneDB (`docker compose up -d serenedb`, bound to
127.0.0.1:7890 only), downloads `BGL.zip` and `OpenStack.tar.gz` from
[Zenodo](https://zenodo.org/records/8196385) into `.data/raw` if they are
missing (about 63 MB, 810 MB unpacked; every file is checked against a pinned
SHA-256), loads them into SereneDB and prints the load balance. It needs no
tools besides Docker, Node and pnpm, takes about a minute on an Apple M laptop
and can be rerun at any time: a second run downloads nothing and yields the
same data version.

The password seeds the SereneDB superuser when its data volume is first
created; to change it later, run `ALTER ROLE` or recreate the volume
(`docker compose down -v`, which deletes all loaded data).

## Scripts

| Script | Purpose |
|---|---|
| `pnpm check` | Lint, types, format, architecture rules, unused code, unit tests |
| `pnpm data:setup [--samples]` | Load BGL and OpenStack into SereneDB (idempotent); `--samples` loads the Loghub 2k samples into the database `log_insights_samples` instead |
| `pnpm data:profile [name …] [--samples] [--wide]` | Read-only profiling queries in `packages/corpus/sql/profiling/` against the loaded corpus; the data decisions cite their results |
| `pnpm test:integration` | Loader, pattern and tool tests against SereneDB with the 2k samples and fixtures, including the comparison with the Loghub templates (needs Docker and `.env`) |
| `pnpm gate [G1 …] [--keep]` | SereneDB compatibility gate (technical spec § 5.2) against the running container; full-corpus probes need `.data/raw/BGL.log` and are skipped without it |

## Tools

Every tool runs through one registry (`packages/analytics`), writes a query
receipt to `.data/receipts/` and returns fact IDs for its numbers. Until the
README tool reference is generated from the registry, this table is kept by
hand; the full descriptions are in the tool definitions.

| Tool | Purpose | Limits |
|---|---|---|
| `describe_corpus` | Datasets with events, time spans, fields, levels, components with their fictional team, labels, known limits, versions and answer guidance per role | – |
| `search_logs` | Full-text search over log messages with BM25 ranking; `total_matches` is exact and comes from the same condition as the hits. Modes: `terms` (default, all words in any order), `phrase` (words adjacent and in order), `fuzzy` (one term with `max_edits` 1–2 typos, default 1) | `limit` 1–50 (default 20), `query` ≤ 200 characters, messages cut to 400 characters; `fuzzy` expands a term to at most 50 index terms per index segment (`sdb_levenshtein_max_terms`), and count and hits use the same expansion |

Matching is case-insensitive on whole tokens without stemming; operators,
quotes and `*` are not evaluated. Hits are examples, never a frequency.

## Data

The base corpus is [Loghub](https://github.com/logpai/loghub) BGL and OpenStack
(Zhu et al., *Loghub: A Large Collection of System Log Datasets for AI-driven
Log Analytics*, ISSRE 2023; BGL: Oliner & Stearley, *What Supercomputers Say*,
DSN 2007). Raw files are never committed.

Load balance of `pnpm data:setup` (17.10.2026):

| Dataset | Lines read | Expected (brief) | Events loaded | Rejected |
|---|---:|---:|---:|---:|
| BGL | 4,747,963 | 4,747,963 | 4,747,945 | 18 |
| OpenStack | 207,820 | 207,820 | 207,820 | 0 |

Patterns: BGL 684 (43 with a single event, 6.3 %), OpenStack 106 (3, 2.8 %).

The 18 rejected BGL lines have no node and carry fragments of other messages
or binary bytes before `RAS KERNEL INFO`, so their fields cannot be determined;
they are kept verbatim in the table `load_rejects`. Per-file figures are in
`load_report`, the corpus description in `corpus_stats`, checksums, image
digest and rule versions in `load_manifest`.

Time is UTC. BGL time comes from the Unix seconds plus the microseconds of the
text timestamp; the text timestamp itself is US Pacific local time (7 h behind
until 30 Oct 2005, 8 h after). OpenStack timestamps carry no zone and are
assumed to be UTC. BGL (2005–2006) and OpenStack (2017) share no time axis.

Labels belong to the datasets, not to this system: BGL alert categories in the
first column (41 categories, 348,460 lines), and for OpenStack four instance
IDs with injected anomalies (`anomaly_labels.txt`), which mark 100 lines. The
OpenStack labels mark instances, not error lines: no error, warning or 5xx
line names an instance, so they serve as per-instance context only.

### Errors, HTTP status and patterns

Levels are counted as logged. An error event has one of these levels:

| Dataset | Error levels | Other observed levels |
|---|---|---|
| BGL | `FATAL` 855,501, `ERROR` 112,355, `SEVERE` 19,213, `FAILURE` 1,714 | `INFO` 3,735,805, `WARNING` 23,357 |
| OpenStack | `ERROR` 194, `CRITICAL` 2 | `INFO` 204,506, `WARNING` 3,118 |

Every BGL alert line has an error level. OpenStack API accesses (98,733 lines
with an HTTP status, 9,196 of them without request ID) contain 2 server
errors (5xx, both `503`) and 3,969 client errors (4xx, all `404`); rates
always name numerator and denominator.

A pattern is the message with variable values replaced by typed placeholders
(`<NODE>`, `<PATH>`, `<ADDR>`, `<NUM>`, …) within one dataset and component;
diagnostic codes such as HTTP status, termination reasons and exit codes
stay. The masks are in `packages/corpus/sql/20_patterns.sql`. They produce
684 BGL and 106 OpenStack patterns; on the Loghub 2k samples no pattern
merges two Loghub templates (checked in CI). Episodes start after at least
30 minutes without an event of the same pattern.

### Ownership (fictional)

Teams are an invented organisation, "Serene Platform", so that answers can be
grouped by team; the real owners are unknown. Every component observed in the
corpus is listed; `SERV_NET` (3 events) is deliberately left `unowned`, so
counts by team show that category on real data. The reason for each
assignment is stored in the `reason` column of the `ownership` table.

| Team | BGL components | OpenStack components |
|---|---|---|
| Compute Platform | `KERNEL` | `nova-compute` |
| Workload Runtime | `APP` | – |
| Control Plane | `MMCS`, `BGLMASTER`, `CMCS` | `nova-scheduler` |
| Hardware Operations | `HARDWARE`, `LINKCARD`, `MONITOR`, `DISCOVERY` | – |
| API Gateway | – | `nova-api` |
| `unowned` | `SERV_NET` | – |

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
packages/analytics          pool, filter compiler, receipts, tool registry and tools
packages/corpus             pnpm data:setup (loader, SQL, integration tests), pnpm data:profile and the SereneDB gate
packages/domain             pure Zod contracts, fact IDs and rule functions
packages/evals              role eval questions (development set)
packages/ui                 shadcn primitives (Base UI), design tokens, cn()
packages/eslint-config      shared ESLint presets
packages/typescript-config  shared tsconfig presets
```

Conventions for contributors and coding agents are in [AGENTS.md](AGENTS.md).
