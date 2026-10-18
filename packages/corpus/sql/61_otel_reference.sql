-- Indexed reference window of the otel dataset (LOG-35, design D3.1): one
-- view over a glob that matches exactly the two files around one file
-- boundary, restricted to the window, and one inverted index on it. Runs
-- after 60_otel_sources.sql, whose assigned ranges src/load.ts reads to fill
-- DEDUPE; the other placeholders come from the catalog:
--   GLOB       s3:// glob over the allowlisted files (the same objects as
--                  their HTTPS URLs; a glob keeps the view on the fast path,
--                  a list of URLs would make it generic, probe § 5.4), or the
--                  fixture glob with --samples
--   FROM TO the window [from, to) as nanosecond literals
--   DEDUPE     per file: filename = its glob name AND its half-open
--                  assigned range, so a boundary row of both files counts once
--
-- The view body stays a column subset with renames and a WHERE (fast path:
-- matched rows can be re-read from the files). Expressions such as event_id
-- or is_error would make it generic, so analytics derives them over the
-- index (packages/analytics/src/relations.ts). Time filters compare the
-- TIMESTAMPTZ_NS column with TIMESTAMPTZ_NS literals: microsecond literals
-- round the column, any expression on it disables pruning (probe § 2.4).
CREATE OR REPLACE VIEW otel_ref AS
SELECT
  "Timestamp" AS ts,
  "SeverityText" AS level,
  "ServiceName" AS component,
  "ScopeName" AS source_type,
  "TraceId" AS trace_id,
  "SpanId" AS span_id,
  "SeverityNumber" AS severity_number,
  "Body" AS message,
  file_row_number
FROM read_parquet('{{GLOB}}', filename = true, file_row_number = true)
WHERE "Timestamp" >= '{{FROM}}'::TIMESTAMPTZ_NS
  AND "Timestamp" < '{{TO}}'::TIMESTAMPTZ_NS
  AND ({{DEDUPE}});

-- The same dictionary as log_events_idx (log_text, 50_index.sql), so counts
-- and hits follow the same analyzer. Service, level and trace ID are indexed
-- verbatim; ts and file_row_number are INCLUDE columns: the time range stays
-- an exact column filter outside the postings (gate G4) and file_row_number
-- forms the event_id without reading the files. Materializing a column that
-- is neither indexed nor included (filename) fails on 26.10.1 (LOG-35).
CREATE INDEX otel_ref_idx ON otel_ref USING inverted (
  component, level, trace_id, message log_text)
INCLUDE (ts, file_row_number)
WITH (optimize_top_k = 'bm25(1.2, 0.75)');
