# SereneDB functions and query evidence

This reference documents implemented SQL paths, with complete saved tool receipts
from the real BGL and OpenStack corpus. These are development examples captured
on 17–18 October 2026, data version `dv_7ea6fcb2c9eb6882`, using SereneDB 26.10.1 on
the local ARM64 build. Each receipt retains its original tool version, exact SQL,
bound parameters, result, facts, scope, population, row limit, truncation flag,
database duration, query signature and result digest. The copies are unchanged.

They demonstrate engine capabilities. They do not establish current-release
answer quality, a role comparison, a first holdout result, causal proof or business
impact. Some receipts predate newer output fields. Re-running with another tool
or data version can produce a different digest; the original remains evidence of
the recorded execution only.

## Where computation happens

SereneDB parses corpus files, searches, aggregates, computes percentiles, forms
episodes and precursor anchors, compares periods and applies the domain rules.
TypeScript validates inputs, compiles allowlisted SQL, preserves missing values,
assigns fact IDs, writes receipts and compares submitted claims with stored facts.
It does not compute corpus totals, rates, rankings or hypothesis status from
sampled log lines. `check_claims` verifies the cited value, metric and required
group; it does not validate an explanation or prove causality.

The [complete historical corpus description](evidence/r_676abcd3.json) also
preserves the base load balance, fields, levels, fictional ownership and original
guidance version. Its guidance is historical source material, not the current
release prompt.

## Implemented query paths

| SereneDB function or SQL feature | Tool | Concrete task and limit | SQL source | Complete example receipt |
|---|---|---|---|---|
| `plainto_tsquery`, `ts_lexize`, inverted index, `BM25` | `search_logs`, shared text filters | Tokenize messages, require all query terms and rank bounded examples by relevance. The exact total is a separate aggregation over the same predicate; hits alone are not a frequency. | [Text search](../packages/analytics/src/text-search.ts), [search SQL](../packages/analytics/src/tools/search-logs.ts), [index definition](../packages/corpus/sql/50_index.sql) | [r_feb1ffab](evidence/r_feb1ffab.json), one returned hit; truncated |
| `ts_phrase` | `search_logs` | Require adjacent tokens in their original order. This receipt searches `instruction address` in BGL on 14 June 2005 UTC. | [Text search](../packages/analytics/src/text-search.ts), [search SQL](../packages/analytics/src/tools/search-logs.ts) | [r_c59fbe9e](evidence/r_c59fbe9e.json), three returned hits; truncated |
| `ts_levenshtein`, `ts_offsets` | `search_logs` | Fuzzy token matching and index-derived highlight ranges. This receipt uses `parrity` with one edit. Byte offsets are translated into Unicode code-point ranges for safe rendering; no HTML is taken from the index. Expansion is bounded per index segment. | [Text search](../packages/analytics/src/text-search.ts), [search SQL and offset conversion](../packages/analytics/src/tools/search-logs.ts) | [r_84999dea](evidence/r_84999dea.json), five returned hits; truncated |
| `unnest(range(...))`, `date_trunc`, `LEFT JOIN`, `coalesce` | `event_trend` | Build the half-open UTC bucket grid in SQL and join observations to it. Missing observations inside the dataset span can be zero; time outside that span is not emitted as zero. This example has two populated hourly buckets; zero and boundary behavior has separate integration coverage. | [Trend SQL](../packages/analytics/src/tools/event-trend.ts), [grid helpers](../packages/analytics/src/sql.ts), [integration tests](../packages/analytics/tests/integration/event-trend.test.ts) | [r_71fdf89a](evidence/r_71fdf89a.json), complete two-hour scoped result |
| `quantile_cont(latency_ms, [...])`, `count(*) FILTER`, `count(DISTINCT ...)` | `latency_stats` | Compute continuous latency percentiles together with access counts, missing request IDs and 4xx/5xx rates over their explicit access denominator. Unique request IDs are a separate counting unit. This ungrouped result is in `result.total`; an empty `groups` array is not an empty population. | [Latency SQL](../packages/analytics/src/tools/latency-stats.ts) | [r_2bb56624](evidence/r_2bb56624.json), complete OpenStack span, ungrouped |
| `MATCH_RECOGNIZE`, `CLASSIFIER`, `MATCH_NUMBER`, `PREV` | `recurring_patterns` | Form episodes after the complete scope filter, ordered by timestamp and event ID. A gap of at least 30 minutes begins another episode; matched lines and episodes are not incidents or outages. | [Episode SQL](../packages/analytics/src/tools/recurring-patterns.ts) | [r_1f63d33f](evidence/r_1f63d33f.json), top three investigation candidates; truncated |
| `CASE`, `count_if`, `row_number`, window aggregates, relational comparisons | `recurring_patterns` | Apply R-05/R-10 recurrence and status, R-08 technical investigation order and R-09 dominance. A ranking dimension unavailable for any candidate is dropped for all. The comparison covers all checked candidates; the visible list is bounded. No composite risk score is calculated. | [Pattern SQL](../packages/analytics/src/tools/recurring-patterns.ts), [ranking and dominance SQL](../packages/analytics/src/tools/recurring-pattern-rules.ts) | [r_1f63d33f](evidence/r_1f63d33f.json); unavailable breadth and baseline increase are explicit |
| `MATCH_RECOGNIZE`, `FIRST`, `PREV`, range joins, `count(DISTINCT ...)`, `row_number` | `get_log_context`, `mode: aggregate` | Use episode starts as anchors, find other patterns before/after them and compute anchor share, grid-window base rate and their ratio. Anchor filters do not hide context elsewhere in that dataset. Temporal association is not a cause. | [Anchor and precursor SQL](../packages/analytics/src/tools/get-log-context.ts) | [r_c25c95da](evidence/r_c25c95da.json), full BGL span, both directions, 60-minute windows; top ten patterns per direction, truncated |
| `sum(...) OVER ()`, `row_number`, `CASE`, grouped aggregates | `count_events`, `compare` | Compute group counts and shares, complete-population totals, bounded rest groups, period deltas and R-06 classification in SQL. An out-of-span reference remains not determinable. This example compares two adjacent hours for one BGL pattern and team. | [Count and comparison SQL](../packages/analytics/src/tools/count-events.ts), [coverage SQL](../packages/analytics/src/comparison.ts) | [r_62ef5805](evidence/r_62ef5805.json), complete filtered comparison |

Loader-only features are visible in the [raw reader](../packages/corpus/sql/05_read.sql),
[BGL parser](../packages/corpus/sql/10_bgl.sql) and
[OpenStack parser](../packages/corpus/sql/11_openstack.sql): `read_csv` with reject
capture, `regexp_extract` and timestamp conversion. Loader provenance and reject
counts belong to `load_manifest` and `load_report`, not to a fabricated tool
receipt. Independent full-corpus Golden queries use separate SQL formulations;
their implementation is under [tests/golden](../packages/analytics/tests/golden).

`read_json` receipt statistics are documented by the separate
[`report:perf` workflow](../DEVELOPMENT.md#database-performance-report). They measure
database round trips recorded by tools, not model waiting time or complete
investigation duration.

## Inspect and reproduce

Open a receipt and inspect `input`, `scope`, `sql`, `params`, `result` and `facts`
together. Its `signature` identifies tool/version/input; `data_version` identifies
the loaded corpus; `result_digest` hashes only the canonical result. These are
different checks. A valid hash alone does not establish the truth of a model's
claim or the fairness of an evaluation.

Start from the [README setup](../README.md#getting-started), run
`describe_corpus` to check the current version and execute the receipt's `tool`
with its `input` through the registry/MCP. The server always builds SQL from the
current registered tool, never by executing the stored SQL. In the web evidence
drawer, **Re-run** creates a new receipt and reports **Same result**, **Data version
changed**, **Query signature changed** or **Result differs**. Exported example
receipts are not imported into the live store automatically.

The examples contain bounded original public log evidence under the Loghub
[CC BY 4.0 terms](https://zenodo.org/records/8196385), with attribution and citation
in the [README](../README.md#data). Raw corpus files remain excluded from Git.
