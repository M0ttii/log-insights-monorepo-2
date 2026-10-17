# Log Insights

Log Insights turns the BGL and OpenStack log corpus into **question → evidence →
recommendation** for three roles: engineer, team lead and manager. SereneDB
searches and computes; Claude explains and recommends; every number has a query
receipt.

> **Status:** SereneDB runs via Docker Compose and passed the compatibility
> gate (`pnpm gate`); `pnpm data:setup` loads the corpus. The tool layer, the
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
| `pnpm test:integration` | Loader tests against SereneDB with the 2k samples and fixtures (needs Docker and `.env`) |
| `pnpm gate [G1 …] [--keep]` | SereneDB compatibility gate (technical spec § 5.2) against the running container; full-corpus probes need `.data/raw/BGL.log` and are skipped without it |

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
first column, and for OpenStack four instance IDs with injected anomalies
(`anomaly_labels.txt`), which mark 100 lines.

### Ownership (fictional)

Teams are an invented organisation, "Serene Platform", so that answers can be
grouped by team; the real owners are unknown. Draft until profiling (U03).
Components without a team are counted as `unowned` (currently BGL `SERV_NET`).

| Team | BGL components | OpenStack components |
|---|---|---|
| Compute Platform | `KERNEL` | `nova-compute` |
| Workload Runtime | `APP` | – |
| Control Plane | `MMCS`, `BGLMASTER`, `CMCS` | `nova-scheduler` |
| Hardware Operations | `HARDWARE`, `LINKCARD`, `MONITOR`, `DISCOVERY` | – |
| API Gateway | – | `nova-api` |

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
packages/corpus             pnpm data:setup (loader, SQL, integration tests) and the SereneDB gate
packages/ui                 shadcn primitives (Base UI), design tokens, cn()
packages/eslint-config      shared ESLint presets
packages/typescript-config  shared tsconfig presets
```

Conventions for contributors and coding agents are in [AGENTS.md](AGENTS.md).
