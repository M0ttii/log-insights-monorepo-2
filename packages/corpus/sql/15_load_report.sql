-- Load balance per file (A-02): lines_read = events_loaded + rejected, with a
-- count per reason. {{BGL_LOAD_S}} and {{OPENSTACK_LOAD_S}} are the measured
-- durations of read + parse per dataset, filled in by src/load.ts.

CREATE OR REPLACE TABLE stage_rejects AS
SELECT 'bgl' AS dataset, regexp_extract(filename, '[^/]+$') AS source_file,
  line_no, reason, raw_line
FROM stage_read_rejects_bgl
UNION ALL
SELECT 'bgl', source_file, line_no, reject_reason, line
FROM stage_bgl WHERE reject_reason IS NOT NULL
UNION ALL
SELECT 'openstack', regexp_extract(filename, '[^/]+$'), line_no, reason, raw_line
FROM stage_read_rejects_openstack
UNION ALL
SELECT 'openstack', source_file, line_no, reject_reason, line
FROM stage_openstack WHERE reject_reason IS NOT NULL;

-- Verbatim rejected lines, at most the first 1,000 per dataset and reason.
CREATE OR REPLACE TABLE load_rejects AS
SELECT dataset, source_file, line_no, reason, raw_line
FROM (
  SELECT *, row_number() OVER (
    PARTITION BY dataset, reason ORDER BY source_file, line_no) AS n
  FROM stage_rejects
)
WHERE n <= 1000
ORDER BY dataset, source_file, line_no;

CREATE OR REPLACE TABLE load_report AS
WITH files AS (
  SELECT 'bgl' AS dataset, source_file, file_ord, lines FROM stage_files_bgl
  UNION ALL
  SELECT 'openstack', source_file, file_ord, lines FROM stage_files_openstack
), loaded AS (
  SELECT 'bgl' AS dataset, source_file, count(*) AS events
  FROM stage_bgl WHERE reject_reason IS NULL GROUP BY source_file
  UNION ALL
  SELECT 'openstack', source_file, count(*)
  FROM stage_openstack WHERE reject_reason IS NULL GROUP BY source_file
), reasons AS (
  SELECT dataset, source_file, sum(n) AS rejected,
    to_json(map(list(reason ORDER BY reason), list(n ORDER BY reason))) AS reason_counts
  FROM (
    SELECT dataset, source_file, reason, count(*) AS n
    FROM stage_rejects GROUP BY dataset, source_file, reason
  ) GROUP BY dataset, source_file
)
SELECT
  f.dataset,
  f.source_file,
  f.lines AS lines_read,
  coalesce(l.events, 0) AS events_loaded,
  coalesce(r.rejected, 0)::BIGINT AS rejected,
  coalesce(r.reason_counts, '{}'::JSON) AS reason_counts,
  now() AS loaded_at,
  -- Read and parse run per dataset, not per file; every file of a dataset
  -- carries the dataset's duration.
  CASE f.dataset WHEN 'bgl' THEN {{BGL_LOAD_S}} ELSE {{OPENSTACK_LOAD_S}} END::DOUBLE AS duration_s
FROM files f
LEFT JOIN loaded l USING (dataset, source_file)
LEFT JOIN reasons r USING (dataset, source_file)
ORDER BY f.dataset, f.file_ord;
