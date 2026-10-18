-- The OTLP replay dataset otel_replay (LOG-35, design D7), after the loader
-- has posted the committed fixture to SereneDB's own OTLP/HTTP listener and
-- refreshed its table (src/replay.ts). src/plan.ts fills the placeholders
-- from the catalog and the replay run:
--   TABLE           schema.table of the listener (otlp.otel_logs)
--   REPLAY_ATTR     log attribute with the replay ID
--   ROW_ATTR        log attribute with the fixture row
--   REPLAY_ID       ID of this load's replay
--   EVENT_ID_BASE   catalog eventIdBase of otel_replay
--   ERROR_LEVELS    the catalog's error SeverityText values (R-02)
--   FIXTURE_PATH FIXTURE_SHA256 RECORDS SOURCE_URL  the committed fixture
--   REPLAYED_AT     replay time (= observed_timestamp of every record)
--   TIME_BASIS LABEL_SOURCE  catalog texts
--   FIELD_STATS     one SELECT per catalog column over otel_replay_events
--
-- The view gives the listener's rows of this replay log_events names.
-- "timestamp" is TIMESTAMP_NS holding the UTC wall clock of timeUnixNano;
-- timezone('UTC', …) turns it into the TIMESTAMPTZ_NS instant independent
-- of the session time zone and keeps the nanoseconds (LOG-35 probe § 7.3).
-- Rows of other replays or other exports to the listener are not in it.
CREATE OR REPLACE VIEW otel_replay_events AS
SELECT
  {{EVENT_ID_BASE}}::BIGINT + (log_attributes ->> '{{ROW_ATTR}}')::BIGINT AS event_id,
  'otel_replay'::VARCHAR AS dataset,
  timezone('UTC', "timestamp") AS ts,
  severity_text AS level,
  service_name AS component,
  scope_name AS source_type,
  severity_text IN ({{ERROR_LEVELS}}) AS is_error,
  trace_id,
  span_id,
  severity_number::INTEGER AS severity_number,
  body AS message,
  timezone('UTC', observed_timestamp) AS observed_ts
FROM {{TABLE}}
WHERE log_attributes ->> '{{REPLAY_ATTR}}' = '{{REPLAY_ID}}';

-- Full text with the same dictionary as log_events_idx (log_text), so
-- counts and hits follow the same analyzer as every other dataset (the
-- listener's own otel_logs_idx uses otel_body_dict). The view has
-- expressions, so it is a generic view: every column a tool reads is an
-- INCLUDE column (selecting other real columns fails on 26.10.1). The index
-- is a snapshot of this replay; an export after the load is not in it.
CREATE INDEX otel_replay_idx ON otel_replay_events USING inverted (
  component, level, trace_id, message log_text)
INCLUDE (event_id, dataset, ts, level, component, source_type, is_error,
  trace_id, span_id, severity_number, message, observed_ts)
WITH (optimize_top_k = 'bm25(1.2, 0.75)');

-- What the replay sent and where; the tools read it for receipts and
-- describe_corpus.
CREATE OR REPLACE TABLE otel_replay AS
SELECT
  '{{REPLAY_ID}}' AS replay_id,
  '{{REPLAYED_AT}}'::TIMESTAMPTZ AS replayed_at,
  {{RECORDS}}::BIGINT AS records,
  '{{FIXTURE_PATH}}' AS fixture_path,
  '{{FIXTURE_SHA256}}' AS fixture_sha256,
  '{{SOURCE_URL}}' AS source_url,
  '{{TABLE}}' AS listener_table,
  'otel_replay_events' AS view_name,
  'otel_replay_idx' AS index_name,
  now() AS index_built_at;

-- corpus_stats row: the records are loaded, so events, the span, errors,
-- levels and components count the replayed rows (from the view: grouped
-- counts on the index under a filter are answered from the term dictionary,
-- gate G13). lines_read and rejected stay NULL (no lines are read), patterns
-- NULL (no patterns).
INSERT INTO corpus_stats (dataset, lines_read, events, rejected, first_ts,
  last_ts, error_events, patterns, single_event_patterns, time_basis,
  label_source, levels, components, labels, api_accesses,
  api_accesses_without_request_id, requests)
SELECT
  'otel_replay', NULL, (SELECT count(*) FROM otel_replay_events), NULL,
  (SELECT make_timestamptz(epoch_ns(min(ts)) // 1000) FROM otel_replay_events),
  (SELECT make_timestamptz(epoch_ns(max(ts)) // 1000) FROM otel_replay_events),
  (SELECT count(*) FROM otel_replay_events WHERE is_error),
  NULL, NULL,
  {{TIME_BASIS}},
  {{LABEL_SOURCE}},
  (SELECT to_json(list({'level': level, 'events': n} ORDER BY n DESC, level))
    FROM (SELECT level, count(*) AS n FROM otel_replay_events GROUP BY level)),
  (SELECT to_json(list({'component': component, 'team': team, 'events': n}
      ORDER BY n DESC, component))
    FROM (SELECT e.component,
        coalesce((SELECT o.team FROM ownership o
          WHERE o.dataset = 'otel_replay' AND o.component = e.component), 'unowned') AS team,
        count(*) AS n
      FROM otel_replay_events e GROUP BY e.component)),
  '[]'::JSON,
  NULL, NULL, NULL;

INSERT INTO corpus_field_stats (dataset, field, events_with_value,
  distinct_values, examples)
{{FIELD_STATS}};
