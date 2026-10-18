-- Load metadata of the otel reference window (LOG-35, design D4), after the
-- index exists. src/plan.ts fills the placeholders:
--   GLOB FROM TO  as in 61_otel_reference.sql
--   BUILT_AT BUILD_MS start and duration of the index build (Node)
--   MAPPING_VERSION       VERSIONS.otelMapping
--   ERROR_LEVELS          the catalog's error SeverityText values (R-02)
--   TIME_BASIS LABEL_SOURCE catalog texts
--   FIELD_STATS           one SELECT per catalog column over otel_ref
--
-- otel_reference: what the index holds and when it was built; the tools
-- read it for the window, the receipt and describe_corpus.
-- duplicates_removed: rows the glob yields in the window without the
-- half-open rule, minus the indexed rows: the boundary rows present in
-- both files (90_checks.sql verifies they are byte-identical twins).
CREATE OR REPLACE TABLE otel_reference AS
SELECT
  'otel_ref_idx' AS index_name,
  'otel_ref' AS view_name,
  '{{GLOB}}' AS source_glob,
  '{{FROM}}'::TIMESTAMPTZ AS window_from,
  '{{TO}}'::TIMESTAMPTZ AS window_to,
  '{{BUILT_AT}}'::TIMESTAMPTZ AS built_at,
  {{BUILD_MS}}::DOUBLE AS build_ms,
  (SELECT count(*) FROM otel_ref_idx) AS events,
  (SELECT count(*) FROM read_parquet('{{GLOB}}')
    WHERE "Timestamp" >= '{{FROM}}'::TIMESTAMPTZ_NS
      AND "Timestamp" < '{{TO}}'::TIMESTAMPTZ_NS)
    - (SELECT count(*) FROM otel_ref_idx) AS duplicates_removed,
  '{{MAPPING_VERSION}}' AS mapping_version;

-- corpus_stats row of otel: the span from the footers of the allowlisted
-- files, truncated to microseconds (never rounded); events, lines_read,
-- rejected and patterns stay NULL: the rows are not loaded and have no
-- patterns. error_events, levels and components count the indexed
-- reference window only (describe_corpus says so in counts_cover), read
-- from the view otel_ref (the same rows as the index): a grouped count on
-- the index itself is answered from the term dictionary, which LOG-35
-- found to miscount under a full-text filter.
INSERT INTO corpus_stats (dataset, lines_read, events, rejected, first_ts,
  last_ts, error_events, patterns, single_event_patterns, time_basis,
  label_source, levels, components, labels, api_accesses,
  api_accesses_without_request_id, requests)
SELECT
  'otel', NULL, NULL, NULL,
  (SELECT make_timestamptz(epoch_ns(min(ts_min)) // 1000) FROM otel_sources),
  (SELECT make_timestamptz(epoch_ns(max(ts_max)) // 1000) FROM otel_sources),
  (SELECT count(*) FROM otel_ref WHERE level IN ({{ERROR_LEVELS}})),
  NULL, NULL,
  {{TIME_BASIS}},
  {{LABEL_SOURCE}},
  (SELECT to_json(list({'level': level, 'events': n} ORDER BY n DESC, level))
    FROM (SELECT level, count(*) AS n FROM otel_ref GROUP BY level)),
  (SELECT to_json(list({'component': component, 'team': team, 'events': n}
      ORDER BY n DESC, component))
    FROM (SELECT i.component,
        coalesce((SELECT o.team FROM ownership o
          WHERE o.dataset = 'otel' AND o.component = i.component), 'unowned') AS team,
        count(*) AS n
      FROM otel_ref i GROUP BY i.component)),
  '[]'::JSON,
  NULL, NULL, NULL;

-- Field guide rows of otel over the reference window (view otel_ref: the
-- same rows as the index, read from the files).
INSERT INTO corpus_field_stats (dataset, field, events_with_value,
  distinct_values, examples)
{{FIELD_STATS}};
