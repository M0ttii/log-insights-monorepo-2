# Log Insights

Log Insights turns the BGL and OpenStack log corpus (optionally extended by five
more Loghub datasets: HDFS_v1, OpenSSH, Apache, Linux and ZooKeeper) into
**question → evidence → recommendation** for three roles: engineer, team lead and manager. SereneDB
searches and computes; Claude explains and recommends; every number has a query
receipt.

> **Status:** SereneDB 26.10.1 runs via Docker Compose and passed the
> compatibility gate (`pnpm gate`); `pnpm data:setup` loads the corpus, and the data
> decisions below come from profiling it (`pnpm data:profile`). All eight
> tools exist (`describe_corpus`, `search_logs`, `get_log_context`,
> `count_events` with `compare`, `event_trend`, `recurring_patterns` with
> `rank: investigation_order`, `latency_stats`, `check_claims`). The stdio MCP
> server exposes the registry and shared role playbooks to Claude clients. The web workspace provides role-aware investigations,
> live corpus analytics, log search, event context and shared query receipts.
> The agent `runInvestigation` (`@workspace/agent/ai-sdk`, AI SDK 7) runs the
> phases preflight, investigate, coverage, answer, gate and one revision and is
> callable through `pnpm --silent agent:ask` and the streaming Ask chat. Role
> comparison, complete live acceptance for all three web roles, and full
> MCP-client role acceptance remain open.

## Requirements

- Node.js 24 (see `.nvmrc`)
- pnpm 11 (pinned via `packageManager`; Corepack picks it up)
- Docker with Compose (SereneDB only)

## Getting started

```bash
pnpm install
pnpm check

cp .env.example .env            # then set SERENEDB_PASSWORD, e.g. openssl rand -hex 16,
                                # and SERENEDB_IMAGE (see "SereneDB image" below)
pnpm data:setup                 # starts SereneDB, downloads and loads the corpus
```

`pnpm data:setup` starts SereneDB (`docker compose up -d serenedb`, bound to
127.0.0.1 only, port `SERENEDB_PORT`, default 7890), checks the image
identity, downloads `BGL.zip` and `OpenStack.tar.gz` from
[Zenodo](https://zenodo.org/records/8196385) into `.data/raw` if they are
missing (about 63 MB, 810 MB unpacked; every file is checked against a pinned
SHA-256), loads them into SereneDB and prints the load balance. It needs no
tools besides Docker, Node and pnpm, takes well under a minute on an Apple M
laptop and can be rerun at any time: a second run downloads nothing and yields
the same data version.

The password seeds the SereneDB superuser when its data volume is first
created; to change it later, run `ALTER ROLE` or recreate the volume
(`docker compose down -v`, which deletes all loaded data).

### Web workspace

Run `pnpm dev` and open [Log Insights](http://127.0.0.1:3000). The app reads the
repository `.env` and uses the same analytics registry and `.data/receipts/` as
MCP. It binds to loopback only. Set `ANTHROPIC_API_KEY` in `.env` to enable Ask;
without it the composer explains that no model is configured. Ask streams the
shared agent's tools and answer, shows a collapsed draft when a revision occurs,
and links cited facts to their receipts. Each `check_claims` call has its own
verification line; unchecked facts and uncited numbers are separate syntactic
markings, not a judgment of the explanation. Stop retains completed receipts.
`Export run` downloads the answer, its tool results and public run metadata,
without server instructions or credentials. Role comparison and recorded-run
import remain separate work. Overview, Logs, Corpus and receipts use real tools; no demo
findings are substituted when the database is unavailable.

Follow-up questions restore the full private model history from a matching
completed local run, including draft and tool context. Role, model or contract
changes start from safe text context instead. Uploaded tool outputs and reasoning
are never trusted as conversation evidence. Requests are limited to 1 MiB, 40 messages and
4000 characters per question; start a new investigation when the limit is reached.

The shell, sidebar, composer, timeline and receipt presentation adapt the earlier
`log-insights` demo. Its fixtures, investigation history and quality pages are
not included. Themes use the SereneDB kit, with Urbanist and locally hosted Geist
Mono. The production build uses Next's supported webpack bundler.

Run `pnpm build` before `pnpm test:e2e` (install Chromium once with
`pnpm --filter web exec playwright install chromium`). Browser checks cover
1280 × 800, 1920 × 1080 and a narrow mobile viewport. Without database
configuration the app shows recoverable unavailable states.

### SereneDB image

The project runs SereneDB 26.10.1 (source tag `v26.10.1`, commit `3d12e1a8`).
`SERENEDB_IMAGE` in `.env` has no default and selects one of two verified
builds:

| Platform | `SERENEDB_IMAGE` | Notes |
|---|---|---|
| Apple Silicon (linux/arm64) | `local/serenedb:26.10.1-arm64` | **Unofficial local build, not published.** The official 26.10.1 release has no ARM64 image. Restore it with `docker image load --input <archive>/docker-image.tar.gz`; it is never pulled, and the loader accepts it only with image ID `sha256:fd1b1353…7fb0` |
| linux/amd64 (CI) | `serenedb/serenedb:26.10.1@sha256:6d41ac6577e797289158786a2015ba8fbd6875feadb5c491518e166c011058c9` | Official release, pinned by digest; emulated on Apple Silicon it does not start |

`load_manifest` records the image reference, its image ID and
`SELECT version()`. Load into a fresh volume: a volume created by another
SereneDB version is not reused. A second checkout can run next to the first
with its own `COMPOSE_PROJECT_NAME` (own container and volume) and
`SERENEDB_PORT` in its `.env`; `pnpm data:setup` and the integration tests
use those settings. Build provenance, restore and rollback to 26.09.1.3 are
in the technical spec (§ 5.1).

## Scripts

| Script | Purpose |
|---|---|
| `pnpm dev` | Start the preliminary web workspace on 127.0.0.1:3000 |
| `pnpm build` | Build the web workspace |
| `pnpm test:e2e` | Browser and accessibility checks against a production build |
| `pnpm check` | Lint, types, format, architecture rules, unused code, unit tests |
| `pnpm data:setup [--samples] [--with <ids>\|all]` | Load BGL and OpenStack into SereneDB (idempotent); `--with hdfs,openssh,apache,linux,zookeeper` (or `all`) adds the extension datasets; `--samples` loads the Loghub 2k samples into `log_insights_samples` instead (with `--with` into `log_insights_samples_ext`) |
| `pnpm data:profile [name …] [--samples] [--wide]` | Read-only profiling queries in `packages/corpus/sql/profiling/` against the loaded corpus; the data decisions cite their results |
| `pnpm test:integration` | Loader, pattern and tool tests against SereneDB with the 2k samples and fixtures, including the comparison with the Loghub templates (needs Docker and `.env`) |
| `pnpm --silent mcp` | Run the stdio MCP server over the shared tool registry |
| `pnpm --silent agent:ask --role <role> [--variant baseline] [--effort high] "<question>"` | Run one `runInvestigation` (`engineer`, `team_lead`, `manager` or `auto`) against the loaded corpus; prints the final answer and the run record path (`.data/runs/<run_id>.json`) on stdout, diagnostics on stderr; needs `ANTHROPIC_API_KEY` |
| `pnpm --silent mcp:desktop-config` | Print the Claude Desktop configuration with absolute paths |
| `pnpm test:mcp` | MCP stdio smoke and shutdown checks against the loaded 2k samples |
| `pnpm test:golden [file-filter …]` | Independent, read-only SQL comparisons for all eight tools against the full corpus, plus raw-file/load reconciliation; local only, excluded from `pnpm test` and CI |
| `pnpm gate [G1 …] [--keep]` | SereneDB compatibility gate (technical spec § 5.2) against the running container; full-corpus probes need `.data/raw/BGL.log` and are skipped without it |

Golden tests require `.env`, the loaded full corpus (`load_manifest.source =
'corpus'`) and the original files under `.data/raw/`. They never start containers
or load data. Each Golden file names its independent author. The queries are
written from the specification without importing tool implementations or the
filter compiler; the tested tools are called through the registry with client
`test`. Counts compare exactly, decimal comparisons allow 1e-9 absolute plus
1e-9 relative error, and UTC timestamps preserve microseconds.

Per-query Golden timings and tool database/wall timings, receipt IDs and result
digests are printed and saved in `.data/golden/*.jsonl`; receipts remain in the
configured receipt directory. Run without other database workloads for the
full-BGL precursor benchmark (`both`, 60 minutes). Its Golden timing measures
anchor-summary validation; complete precursor rows are independently checked by
the smaller aggregate cases. These single-run timings are not a performance
percentile report.

## MCP connection

Start the server with `pnpm --silent mcp`. stdout contains MCP messages only;
operational logs go to stderr. The root `.env` is loaded at startup, and receipts
use `<repository>/.data/receipts` even when the client starts elsewhere.
`LOG_INSIGHTS_RECEIPTS_DIR` overrides that location; relative paths remain relative
to the repository.

Claude Code loads `log-insights` from the repository's `.mcp.json`. Approve that
server in Claude Code, then ask it to call `describe_corpus`. To register it from
another directory:

```bash
claude mcp add log-insights -- pnpm --dir /absolute/path/to/repository --silent mcp
```

For Claude Desktop, run `pnpm --silent mcp:desktop-config` and add the printed
`log-insights` entry to the `mcpServers` object in your Desktop configuration,
preserving existing entries. Restart Desktop, select the local server and ask it
to call `describe_corpus`. The generated block uses absolute Node, tsx, source and
`.env` paths, so Desktop needs no shell PATH. Regenerate it after moving the
repository or changing the Node installation. It contains no credentials.

The server exposes eight read-only tools, `corpus://overview`, `corpus://schema`,
`corpus://ownership` and `receipt://{id}`. Each corpus resource uses
`describe_corpus` and stores a receipt; its facts resolve against that full
receipt. The schema resource lists the same available analytical fields as
`describe_corpus`. Ownership is fictional. Missing receipts return `not_found`
with a correction hint.

The server loads the versioned playbooks from `@workspace/agent/playbooks`.
Choose `/mcp__log-insights__engineer_investigation`,
`/mcp__log-insights__team_lead_review` or
`/mcp__log-insights__manager_priorities` in Claude Code; in Claude Desktop choose
the corresponding prompt from the input's prompt menu. Each accepts optional
`question`, `dataset`, `from` and `to` arguments. Without a selected prompt,
server instructions and `describe_corpus.answer_guidance` provide role routing,
the required answer sections and checks before a recommendation; an unclear
perspective calls for clarification. `guidance_version` identifies the playbook
bundle in the corpus result and receipt. Prompts guide the model; the server does
not inspect the client's final answer. Optional index tools follow in U21, so enabling
`LOG_INSIGHTS_WORKSPACE_TOOLS=1` currently still exposes eight tools.

Successful tool calls include the complete validated JSON result in a text block
as well as structured content, so clients that expose only text to the model
still receive dataset/group labels, role guidance, evidence and all fact IDs.
The same playbook instructions also accompany successful tool results, covering
clients that omit Initialize instructions from the model's context.
If a local Desktop extension launches this checkout, its MCPB manifest must allow
the server's generated prompts (`prompts_generated: true`); an older launcher
manifest can list prompts yet block their retrieval. See the
[MCPB manifest specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md).

`pnpm test:mcp` checks actual stdio messages, advertised schemas, resources,
receipts, actionable errors, process shutdown and startup
from another working directory against the Loghub 2k samples. It also starts the
generated Desktop command. CI runs this after loading samples. Unit tests in
`pnpm test` cover cancellation routing and playbook-source registration. The smoke
also checks all three prompts, Initialize instructions and persisted corpus
guidance against the same playbook source. Actual model behavior remains a
separate acceptance check. Desktop development probes (UI model: Opus 5.5)
retrieved all three prompts and produced distinct role cores with and without
prompt selection. Initialize instructions alone did not reliably guide the
model; complete result text and repeated instructions improved role uptake, but
some runs still skipped the initial `describe_corpus` call. Bundle 1.0.2 narrowed
the observed per-node generalization and preserved signed offsets in a repeated
Engineer probe and elicited a perspective question for an unclear request;
unsupported broader conclusions and uncited quantities remained.
Full answer-contract acceptance is still open. Probe chat links, receipt IDs and
observed gaps are recorded in Linear LOG-39, without formal U16 scoring. Claude
Code was not signed in and no API key was configured during these checks, so
its model probes remain pending; transport tests do not establish model behavior.

The [focused S-15 regression](packages/evals/results/s15-2026-10-18-r5/report.json)
passes all three predeclared valid Desktop attempts with guidance bundle 1.0.5.
Each executes the real precursor check and separates temporal association,
symptom distribution and unproven causal origin, including proposed next checks.
The [initial round](packages/evals/results/s15-2026-10-18/report.json),
[second round](packages/evals/results/s15-2026-10-18-r2/report.json),
[third round](packages/evals/results/s15-2026-10-18-r3/report.json) and
[invalid infrastructure attempt](packages/evals/results/s15-2026-10-18-r4/report.json)
remain available with all answers, receipt excerpts and independent ratings. The
initial overgenerous rating is preserved with its correction audit. Material
broader answer defects remain documented: this focused result does not establish
the full U16 threshold, whole-answer numerical correctness, a baseline comparison
or a holdout result. The saved model runs pin contract 2.9.0; the report separately
records checks of the combined 2.10.0 code after integrating current main. The
playbooks and `get_log_context` source were unchanged by that integration.

## Tools

Every tool runs through one registry (`packages/analytics`), writes a query
receipt to `.data/receipts/` and returns fact IDs for its numbers. Until the
README tool reference is generated from the registry, this table is kept by
hand; the full descriptions are in the tool definitions.

SereneDB computes episodes and precursor anchors with `MATCH_RECOGNIZE`
after applying the full scope filter. Gate G11 covers timestamp ties, the
30-minute boundary and filtered episodes; the independent golden queries
check the results against a separate formulation.

LOG-32 adopted this formulation on SereneDB 26.10.1 with unchanged results:
19 captured sample/fixture cases preserve result digests and every fact
(normalizing only its random receipt prefix); 42 full-BGL comparisons
(14 inputs, three runs per variant) also match exactly. Gate G11 runs
locally and in the loader CI job on the official amd64 image. The existing
64 independent full-corpus golden tests pass without changes.

Measured locally on `local/serenedb:26.10.1-arm64`, data version
`dv_7ea6fcb2c9eb6882`, full BGL span, three sequential runs per variant:

| Input | Previous `lag` (ms) | `MATCH_RECOGNIZE` (ms) |
|---|---:|---:|
| `recurring_patterns`, all patterns, `rank: episodes`, `limit: 5` | 297–363 | 546–749 |
| `recurring_patterns`, most events (`10d868eba093620d`), default rank/limit | 135–140 | 296–304 |
| `recurring_patterns`, rarest (`08b2f3b54c74ecf0`), default rank/limit | 22–23 | 25–25 |
| `get_log_context`, most episodes (`8eb053329ba11348`), before, 10 min | 4,021–4,230 | 1,422–1,451 |
| Same anchor, both directions, 60 min | 5,803–6,366 | 3,245–3,473 |
| `get_log_context`, rarest, both directions, 60 min | 17–18 | 19–20 |

Times include the receipt write and are observed ranges, not p95 estimates
or a general speed guarantee. Context calls use `mode: aggregate`,
`top_n: 10`, and the stated `pattern_id`, without additional filters. The
longest SQL statement in the new measurements took 3,445 ms, below the
pool's 10-second limit. Simple rankings became slower; the anchor-heavy
precursor analysis became faster. Example receipts with the new SQL are
`r_24652459` (ranking), `r_c25c95da` (1,561 anchors, both directions), and
`r_d08e0b4b` (one anchor). Raw comparison records remain locally in
`.data/log32-benchmark-{lag,match}.json`; receipts remain in
`.data/receipts/`. No tool contract or episode rule changed.

LOG-34 evaluated dictionary facets, token regex and indexed ranges on the full
base corpus (`dv_229e422f86a9fc6e`, local ARM64 26.10.1). These are decisions for
follow-up work; the tool registry, search index and data version are unchanged.
Gate G12 reproduces the relevant edge cases without corpus files and runs in the
loader integration suite on the official amd64 image as well.

| Candidate | Decision and measured evidence |
|---|---|
| Implicit dictionary facets | Selected for a bounded optimization in LOG-41. Nullable `GROUP BY` facets preserve the NULL group, including a dataset filter (`EXPLAIN`: `TsDict:`). Full-base-corpus `level` grouping: 4.41–14.46 ms from the table versus 1.26–2.25 ms from the index, with identical rows. Gains depend on scope: OpenStack-only level grouping was slower through the index (3.30–5.67 versus 1.76–1.91 ms). Preserve the current path for unproven shapes. |
| Explicit dictionary aggregates and corpus value lists | Rejected as general replacements: `ts_dict_agg`/`ts_dict_count` omit NULL groups and reject time filters outside the index; marginal facets cannot replace two-dimensional groups. `describe_corpus` already reads precomputed tables (level/component/label lists: 0.72–2.29 ms). |
| `ts_regexp` search mode | Rejected for general identifier/raw-text search: it matches whole analyzed tokens. `r02-m1-n0.*` returns 0 versus 16 raw messages containing that identifier; `0x0054.*` correctly returns 19,740 in 1.18–2.74 ms. Complete ordered lists and counts agree. Invalid `[` silently matches nothing on this image. |
| Indexing `ts` and `event_id` | Rejected in the current scoring design. Three index rebuilds, compaction off/on/manual and 864 repeated range comparisons agree with the base table; 42 additional full ID-set comparisons also agree. However, indexed time filters change returned BM25 scores (first June BGL `parity` hit: 2.1018991 becomes 4.101899). Search times overlap: 2.06–5.47 versus 2.36–3.91 ms for the top 20. |

Times are observed min–max query durations including driver transfer, excluding
receipts: four sequential repetitions for facets/regex and five for the final
search comparison, on an isolated instance. Full-base-corpus facets combine each
dataset's separate full span, never a shared time axis. G12 covers NULLs, joint
distributions, regex boundaries, microsecond ties, exact BIGINT IDs, compaction
and the BM25 change. Local SQL, parameters and plans are in
`.data/log34/{benchmark,final-measure,membership}.json`; the German decision record
is in `docs/technical.md` § 5.3 (local planning docs are gitignored).

| Tool | Purpose | Limits |
|---|---|---|
| `describe_corpus` | Datasets with events, time spans, fields, levels, components with their fictional team, labels, known limits, versions and answer guidance per role | – |
| `search_logs` | Full-text search over log messages with BM25 ranking; `total_matches` is exact and comes from the same condition as the hits. Modes: `terms` (default, all words in any order), `phrase` (words adjacent and in order), `fuzzy` (one term with `max_edits` 1–2 typos, default 1) | `limit` 1–50 (default 20), `query` ≤ 200 characters, messages cut to 400 Unicode code points, with index-derived `match_ranges` (`start` inclusive, `end` exclusive, zero-based code points, no added markup); `fuzzy` expands a term to at most 50 index terms per index segment (`sdb_levenshtein_max_terms`), and count and hits use the same expansion |
| `get_log_context` | Temporal context in two modes. `event`: the events right before and after one `event_id` (from `search_logs`) on the `same_node`, in the `same_component`, with the `same_request` (OpenStack) or in the `dataset`, with exact `offset_ms` (microseconds kept, computed in SereneDB); before covers `[anchor − w, anchor)`, after `(anchor, anchor + w]`, ties on the anchor's timestamp are placed by `event_id`, and each side reports the exact number of events in the window. `aggregate` (precursor analysis, R-11): anchors are the episode starts (gap ≥ 30 min) of a `pattern_id` or a `query` (all words) in one `dataset` after all filters, so a burst is one anchor; per pattern in the window before and/or after: anchors with an occurrence, their share of all anchors, the base rate (share of equally long grid windows from the start of the data span in scope that contain the pattern) and the ratio of both, all computed in SereneDB. Precursors are temporal observations, not causes | `event`: `before`/`after` 0–25 (default 10), `window_minutes` 1–60 (default 10), default scope `same_node` for BGL events with a node, else `same_component`; messages cut to 400 characters. `aggregate`: exactly one `dataset`, `top_n` 1–20 per direction (default 10), anchor patterns excluded, base rate and ratio omitted below five anchors; filters select anchors, window events come from the whole dataset |
| `count_events` | Counts over the stated scope grouped by 1–2 dimensions (`dataset`, `team`, `component`, `level`, `alert_label`, `rack`, `node`, `pattern`, `http_status`, `endpoint`), with exact `total`, `share` per group (fraction of `total`, computed in SereneDB) and the groups beyond `top_n` summed in `other`. Without `from`/`to` each dataset counts over its full span. A missing value is its own category `null`; unmapped components count as team `unowned`. `http_status` and `endpoint` count OpenStack API accesses, not log events. `compare` (`"previous_period"` or an equally long `{from, to}`) adds per group and in total the baseline B, C − B, the change in percent (none when B = 0) and the R-06 classification; a reference outside the data span makes the comparison not determinable instead of reporting B = 0 | `top_n` 1–50 (default 20), with `compare` ≤ 25; `compare` needs one `dataset`, `from`, `to` and one dimension; BGL-only dimensions and filters cannot be combined with `http_status` or `endpoint` |
| `event_trend` | Log events per UTC `hour`, `day` or `week` bucket (weeks start on Monday) for exactly one dataset, optionally `split_by` one dimension into the top 5 series plus `other`. Returns the dataset's `data_span` and the `effective_range` (window ∩ span): empty buckets inside it are observed zeros, buckets outside the span are never listed. Edge buckets are marked `partial`, buckets without any event of the dataset `capture_gap` | At most 120 buckets (otherwise `limit_exceeded` naming the next coarser bucket); `dataset` required, no shared time axis; `http_status` and `endpoint` are no split dimensions |
| `recurring_patterns` | Patterns of exactly one `dataset` with `events`, `first_seen`/`last_seen`, `episodes` (R-05: a new episode after ≥ 30 min without the pattern, computed after all filters, so filtering by node can split an episode), `recurring` (≥ 2 episodes), `active_days`/`active_weeks`, breadth (BGL `nodes` and `racks`, OpenStack `instances` and `requests`; `null` when not every event carries the unit), C − B against the previous equally long period with the same filters and the R-10 `status` (`new`, `escalating`, `reappeared`, `ongoing`, `quiet`; without a determinable reference only `new`/`ongoing`). `rank`: `episodes` (default), `events`, `increase`, `investigation_order`: the error and alert patterns (OpenStack also 5xx accesses) by episodes, breadth, increase, events, `pattern_id` (R-08), a criterion missing for any candidate dropped for all, with `candidates_checked`, `rank_basis`, the leader per criterion, R-09 dominance (`clear_priority` or `trade_off` with the conflicts, over every candidate checked), levels, labels, share of error events and the R-09 limit; no composite score | `limit` 1–25 (default 10); with `investigation_order` 1–5 (default 3) and no `text`, `request_id` or `pattern_id`; `rank: increase` needs a previous period inside the data span |
| `latency_stats` | OpenStack API accesses (lines with an HTTP status, with or without request ID) overall or grouped by `endpoint`, `method`, `status`, `component`, UTC `hour` or `day`: `api_access_events`, `without_request_id`, `unique_requests` (a separate counting unit), `p50_ms`/`p90_ms`/`p95_ms`/`p99_ms`/`max_ms` (continuous percentiles, `quantile_cont` with linear interpolation, over the accesses with a latency), `errors_5xx` (500–599) with `rate_5xx` and `errors_4xx` (400–499, client errors, not failures) with `rate_4xx`, each rate over `api_access_events`, computed in SereneDB. A scope without 5xx says so as an observed zero with its denominator; groups beyond `top_n` are aggregated in `other` over their own accesses; time buckets list every bucket of the data span in scope with `partial` and `capture_gap`. Filters `endpoints` (masked paths) and `http_status` (inclusive range) | OpenStack only (`dataset: bgl` is `invalid_input`); `top_n` 1–20 (default 10) only for `endpoint`, `method`, `status`, `component`; at most 120 time buckets |
| `check_claims` | Checks the numbers of an answer before it is given: per claim it resolves the cited fact ID and compares value, metric and group (required, `{}` for ungrouped facts) with that fact only; a value found in another fact is no evidence. Returns `verified`, `mismatch` with the differing fields, `unknown_fact` or `unknown_receipt` (both count as unresolved) and the line "N claims checked · M mismatch · K unresolved". Number format: comma = thousands separator, dot = decimal point (`1.204` is a decimal); decimals match the fact rounded to the stated places (`0.38` for 0.375), `unit: "percent"` states a ratio in percent, times match as UTC prefix. Checks numbers only, not explanations | 1–30 claims; a malformed fact ID is `unknown_fact` for that claim, not an error for the call; reads receipts only, never the corpus |

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
reference and ID, server version and rule versions in `load_manifest`.

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

### Extension datasets (LOG-40)

`pnpm data:setup --with all` (or a comma-separated subset) adds five Loghub
datasets from the same Zenodo record; the base corpus is always loaded and stays
the default. One catalog, `packages/domain/src/datasets.ts`, pins every raw file
by size and SHA-256 and states per dataset the time basis, field meanings, error
definition, breadth unit, context scopes and capabilities; filters, dimensions,
the loader plan and `describe_corpus` (field guide with real example values)
derive from it. A new similar source is one catalog entry, one parser SQL file
and ownership rows. Each load replaces the previous one, so name every extension
you want. With all seven datasets the load takes about 60 s locally
(full rerun from present raw files, Apple M3).

Load balance (18.10.2026, `--with all`, data version `dv_02dfa8cc8e16e2a2`):

| Dataset | Lines read | Expected (Loghub) | Events loaded | Rejected | Patterns | Span (UTC, assumed) |
|---|---:|---:|---:|---:|---:|---|
| HDFS_v1 (`hdfs`) | 11,175,629 | 11,175,629 | 11,175,629 | 0 | 54 | 2008-11-09 – 2008-11-11 |
| OpenSSH (`openssh`) | 655,147 | 655,146 + unterminated last line | 655,147 | 0 | 104 | 2017-12-10 – 2018-01-07 |
| Apache (`apache`) | 56,482 | 56,481 + unterminated last line | 52,004 | 4,478 | 37 | 2005-06-09 – 2006-02-28 |
| Linux (`linux`) | 25,567 | 25,567 | 25,547 | 20 | 765 | 2005-06-09 – 2006-02-28 |
| ZooKeeper (`zookeeper`) | 74,380 | 74,380 | 74,380 | 0 | 124 | 2015-07-29 – 2015-08-25 |

BGL and OpenStack rows stay identical with the extensions loaded (column
fingerprints of all 4,955,765 rows match the previous load); the data version
changes because the loader SQL, rule versions and dataset list are part of it.

- **Time:** no extension log names a zone; times are assumed UTC. OpenSSH and
  Linux lines carry no year: OpenSSH is December 2017 and January 2018 after its
  single month wrap (archive entry dated 2018-01-07), Linux June–December 2005
  and January–February 2006, confirmed by every full date that `ftpd` writes
  into its messages. Load checks fail on a second wrap or a mismatching date.
- **Rejects:** Apache has 4,478 bare continuation lines ("script not found or
  unable to stat") without time or level, rejected instead of borrowing a time;
  Linux has 20 lines of invalid UTF-8 (format-string attacks on `rpc.statd`).
- **Errors (R-02):** levels as logged, never mapped across formats. HDFS and
  ZooKeeper `ERROR`/`FATAL` (HDFS has none; `WARN` is a warning), Apache
  `error` and higher (38,081), OpenSSH messages prefixed `error:` or `fatal:`
  (its levels ERROR and FATAL, 2,087). Linux has neither a level nor a marker:
  its error events are unknown, so `only_errors` and `investigation_order` are
  rejected for `linux` with a hint.
- **Fields:** `block_id` (HDFS; null for a line naming several blocks),
  `host` and `process_id` (OpenSSH, Linux), `client_ip` (OpenSSH remote
  address in fixed message forms, Apache `[client …]`), `thread` (ZooKeeper).
  No base-corpus field is reused with another meaning. HDFS block labels
  (Normal/Anomaly) are dataset labels per block, like the OpenStack instance
  labels.
- **No shared time axis:** Apache and Linux overlap BGL's calendar but are other
  systems with unknown zones; trends, comparisons, context and precursors stay
  per dataset.

Tool applicability (unsupported combinations return `invalid_input` with a
hint, never a zero):

| Function | bgl | openstack | hdfs | openssh | apache | linux | zookeeper |
|---|---|---|---|---|---|---|---|
| search, counts, trends, recurring patterns, precursors | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `only_errors`, `rank: investigation_order` | ✓ | ✓ | ✓ (0 errors) | ✓ | ✓ | – | ✓ |
| Breadth (R-08) | nodes | instances | blocks | client IPs | client IPs | – | – |
| Context scopes besides `same_component`, `dataset` (default first) | `same_node` | `same_request` | `same_block` | `same_process`, `same_client` | `same_client` | `same_process` | `same_thread` |
| API accesses, `latency_stats` | – | ✓ | – | – | – | – | – |

Independent golden tests (`packages/analytics/tests/golden/extensions.test.ts`,
30 cases, raw-file oracles) cover load balance, search, context, counts, weekly
trends and episodes for each extension. One role question per extension with its
tool calls, receipt IDs and a clean `check_claims` is in
[`packages/evals/u26`](packages/evals/u26/README.md) (development evidence,
answers composed without a model).

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

Extensions (ownership 1.1.0): **Storage Platform** owns the HDFS datanode
classes; **Control Plane** additionally the HDFS namenode classes
(`dfs.FSNamesystem`, `dfs.PendingReplicationBlocks…`); **Access Services**
OpenSSH `sshd` and the Linux login and remote-access programs (`sshd(pam_unix)`,
`su(pam_unix)`, `ftpd`, `telnetd`, `xinetd`, …); **Web Platform** Apache `httpd`
and Linux `httpd`; **Coordination Services** every ZooKeeper class; **Compute
Platform** additionally Linux `kernel` and `udev`. The 60 rarer Linux programs
(1,472 events, e.g. `named`, `cups`, `smartd`) stay `unowned` on purpose; the
list is in `load_checks`.

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

Click **Run** to launch the `web` dev task through `pnpm dev`. The Next.js
server binds to `127.0.0.1` with `--port 0`, letting the OS select a free port even
when workspaces start simultaneously. Open the URL printed in the terminal or
shown in Superset's Ports panel. Stop it from Superset or with Ctrl+C.
The preliminary `apps/web` workspace now starts through this task.

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
apps/mcp                    stdio MCP server, resources, playbook interface, desktop config and smoke tests
apps/web                    preliminary Next.js workspace; streaming chat pending
packages/analytics          pool, filter compiler, receipts, tool registry and tools
packages/corpus             pnpm data:setup (loader, SQL, integration tests), pnpm data:profile and the SereneDB gate
packages/agent              role playbooks (./playbooks) and the AI SDK agent runInvestigation with run records (./ai-sdk)
packages/domain             pure Zod contracts, fact IDs, rule functions and answer markings (./answer)
packages/evals              role eval questions (development set)
packages/ui                 shadcn primitives (Base UI), design tokens, cn()
packages/eslint-config      shared ESLint presets
packages/typescript-config  shared tsconfig presets
```

Conventions for contributors and coding agents are in [AGENTS.md](AGENTS.md).
