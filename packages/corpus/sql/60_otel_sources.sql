-- Remote OpenTelemetry Parquet sources (LOG-35, technical.md § 7.2): runs
-- only with `--with otel`. Reads the footers of the allowlisted files in
-- SQL, never their data. src/plan.ts fills the placeholders from the
-- catalog and the load-time pins:
--   LOCATIONS  list literal of the file locations (HTTPS URLs, or the
--                  container paths of the committed fixtures with --samples)
--   PINS       VALUES rows (file_index, location, head_size, etag,
--                  head_last_modified) from the Node HEAD (fixtures: size
--                  from the file, no ETag, no header)
--
-- otel_row_groups: one row per Parquet row group with its Timestamp
-- statistics (exact min/max, LOG-35 probe § 1) and the compressed size of all
-- its columns, for the footer estimate in receipts.
CREATE OR REPLACE TABLE otel_row_groups AS
SELECT p.file_index, m.row_group_id,
  any_value(m.row_group_num_rows)::BIGINT AS rows,
  max(CASE WHEN m.path_in_schema = 'Timestamp' THEN m.stats_min_value END)::TIMESTAMPTZ_NS AS ts_min,
  max(CASE WHEN m.path_in_schema = 'Timestamp' THEN m.stats_max_value END)::TIMESTAMPTZ_NS AS ts_max,
  sum(m.total_compressed_size)::BIGINT AS compressed_bytes
FROM parquet_metadata({{LOCATIONS}}) m
JOIN (VALUES {{PINS}}) AS p(file_index, location, head_size, etag, head_last_modified)
  ON p.location = m.file_name
GROUP BY p.file_index, m.row_group_id
ORDER BY p.file_index, m.row_group_id;

-- otel_sources: the allowlisted files with their pins, footer facts and the
-- half-open range each file answers for: [ts_min(n), ts_min(n+1)), the last
-- file up to and including its last row (assigned_to NULL). Adjacent files
-- share or overlap their boundary rows (LOG-35 probe § 4.2); the range keeps
-- each such row in the later file only. size and last_modified are what
-- read_blob reports (one HEAD, no body), the values the tools re-check
-- before every query.
CREATE OR REPLACE TABLE otel_sources AS
WITH pins AS (
  SELECT * FROM (VALUES {{PINS}}) AS p(file_index, location, head_size, etag, head_last_modified)
), footer AS (
  SELECT file_name, num_rows, num_row_groups, file_size_bytes
  FROM parquet_file_metadata({{LOCATIONS}})
), blob AS (
  SELECT filename, size, last_modified FROM read_blob({{LOCATIONS}})
), groups AS (
  SELECT file_index, min(ts_min) AS ts_min, max(ts_max) AS ts_max,
    sum(rows)::BIGINT AS row_group_rows, count(*) AS row_group_count
  FROM otel_row_groups GROUP BY file_index
)
SELECT
  p.file_index::INTEGER AS file_index,
  p.location AS url,
  b.size::BIGINT AS size,
  p.etag::VARCHAR AS etag,
  b.last_modified AS last_modified,
  p.head_size::BIGINT AS head_size,
  p.head_last_modified::TIMESTAMPTZ AS head_last_modified,
  f.file_size_bytes::BIGINT AS footer_file_bytes,
  f.num_rows::BIGINT AS footer_rows,
  f.num_row_groups::BIGINT AS row_groups,
  g.row_group_rows,
  g.row_group_count,
  g.ts_min,
  g.ts_max,
  g.ts_min AS assigned_from,
  lead(g.ts_min) OVER (ORDER BY p.file_index) AS assigned_to
FROM pins p
JOIN footer f ON f.file_name = p.location
JOIN blob b ON b.filename = p.location
JOIN groups g ON g.file_index = p.file_index
ORDER BY p.file_index;
