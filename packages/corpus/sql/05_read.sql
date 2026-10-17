-- Reads the raw files of one dataset verbatim, one row per line. Runs once per
-- dataset with {{DATASET}} = bgl | openstack and {{FILES}} = list of
-- container paths in their fixed load order (src/sources.ts).
--
-- read_csv settings (gate G2): the delimiter is the ASCII unit separator,
-- which the corpus does not contain, and quote/escape are off, so `"` and `\`
-- stay data. An empty line arrives as NULL. Unreadable lines (invalid UTF-8)
-- would abort the read; ignore_errors + store_rejects records them in the
-- session's temporary reject tables instead, which are dropped first so they
-- only hold this read.
DROP TABLE IF EXISTS read_errors_{{DATASET}};
DROP TABLE IF EXISTS read_scans_{{DATASET}};

-- row_number() OVER () follows the reader order, which is the file order and,
-- for several files, the list order (gate G2); OVER (PARTITION BY filename)
-- without ORDER BY would not.
CREATE OR REPLACE TABLE stage_read_{{DATASET}} AS
SELECT row_number() OVER () AS read_no, filename, line
FROM read_csv({{FILES}},
  columns = {'line': 'VARCHAR'}, delim = E'\x1f', quote = '', escape = '',
  header = false, auto_detect = false, filename = true,
  ignore_errors = true, store_rejects = true,
  rejects_table = 'read_errors_{{DATASET}}', rejects_scan = 'read_scans_{{DATASET}}');

-- One row per unreadable physical line; a line with several errors is listed
-- once with its first reason.
CREATE OR REPLACE TABLE stage_read_rejects_{{DATASET}} AS
SELECT s.file_path AS filename, e.line::BIGINT AS line_no,
  min('read_' || lower(replace(e.error_type::VARCHAR, ' ', '_'))) AS reason,
  min(e.csv_line) AS raw_line
FROM read_errors_{{DATASET}} e
JOIN read_scans_{{DATASET}} s USING (scan_id, file_id)
GROUP BY s.file_path, e.line;

-- Physical line numbers. A rejected line is missing from the read rows, so the
-- k-th read row of a file is line k plus the number of rejected lines before
-- it: reject j (in line order) precedes read row r iff line_j - j + 1 <= r.
-- Without rejects this is the plain row number within the file.
CREATE OR REPLACE TABLE stage_lines_{{DATASET}} AS
WITH numbered AS (
  SELECT filename, line,
    read_no - min(read_no) OVER (PARTITION BY filename) + 1 AS read_line
  FROM stage_read_{{DATASET}}
), thresholds AS (
  SELECT filename,
    line_no - row_number() OVER (PARTITION BY filename ORDER BY line_no) + 1 AS first_read_line
  FROM stage_read_rejects_{{DATASET}}
)
SELECT
  n.filename,
  regexp_extract(n.filename, '[^/]+$') AS source_file,
  list_position({{FILES}}, n.filename) AS file_ord,
  n.read_line + (
    SELECT count(*) FROM thresholds t
    WHERE t.filename = n.filename AND t.first_read_line <= n.read_line
  ) AS line_no,
  n.line
FROM numbered n;

-- Lines per file (read + unreadable) and the number of lines in earlier files
-- of the same dataset, for event IDs that run across files (OpenStack).
CREATE OR REPLACE TABLE stage_files_{{DATASET}} AS
WITH per_file AS (
  SELECT filename, count(*) AS lines FROM (
    SELECT filename FROM stage_lines_{{DATASET}}
    UNION ALL
    SELECT filename FROM stage_read_rejects_{{DATASET}}
  ) GROUP BY filename
)
SELECT filename,
  regexp_extract(filename, '[^/]+$') AS source_file,
  list_position({{FILES}}, filename) AS file_ord,
  lines,
  coalesce(sum(lines) OVER (ORDER BY list_position({{FILES}}, filename)
    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS lines_before
FROM per_file;
