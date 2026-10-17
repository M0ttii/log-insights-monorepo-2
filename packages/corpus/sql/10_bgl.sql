-- BGL fields (technical.md § 6.1, concept § 5.1). Profiled on the full
-- corpus (17.10.2026); every rule below is backed by an observed count.
--
-- Line layout: label, Unix seconds, date, node, text timestamp with
-- microseconds, node again, type, component, level, message.
--   - 1117838570 2005.06.03 R02-M1-N0-C:J12-U11 2005-06-03-15.42.50.363779 R02-M1-N0-C:J12-U11 RAS KERNEL INFO instruction cache parity error corrected
-- Variants observed:
--   * `NULL` as type (DISCOVERY, HARDWARE, MONITOR, CMCS, SERV_NET; 104,215
--     lines) and `NULL` as node (89,296 lines) are the log's own marker for
--     an absent value and become SQL NULL.
--   * Shifted layout (306 lines, "Kill job … timed out"): node `-` and the
--     repeated node missing, so type, component and level follow the
--     timestamp directly. Parsed with its own rule; node stays NULL.
--   * Corrupted layout (18 lines): node `-` and a fragment of another message
--     or binary bytes before `RAS KERNEL INFO`. Which tokens are fields is not
--     decidable, so these lines are rejected as bgl_corrupted_fields and kept
--     verbatim in load_rejects.
--   * Lines without message text (34,470, e.g. "… RAS KERNEL INFO"): the
--     message is the empty string, a parsed value, not a missing field.
--
-- Time (R-03): ts = Unix seconds + the microseconds of the text timestamp.
-- The text timestamp is US Pacific local time: it is exactly 7 h (PDT) behind
-- the Unix seconds up to line 3,669,612 and 8 h (PST) after the switch on
-- 30.10.2005 (90_checks.sql verifies that no other offset occurs).
--
-- regexp_extract returns '' for a group that did not participate; NULLIF keeps
-- such values NULL (gate G2).
CREATE OR REPLACE TABLE stage_bgl AS
WITH head AS (
  SELECT source_file, line_no, line,
    regexp_extract(line,
      '^(\S+) (\d+) (\d{4}\.\d{2}\.\d{2}) (\S+) (\d{4}-\d{2}-\d{2}-\d{2}\.\d{2}\.\d{2})\.(\d{6}) (.*)$',
      ['label', 'unix_s', 'date', 'node', 'ts_text', 'micros', 'rest']) AS h
  FROM stage_lines_bgl
), split AS (
  SELECT *,
    regexp_extract(h.rest, '^(\S+) (\S+) (\S+) (\S+)(?: (.*))?$',
      ['node', 'source_type', 'component', 'level', 'message']) AS regular,
    regexp_extract(h.rest, '^(RAS|NULL) (\S+) (\S+)(?: (.*))?$',
      ['source_type', 'component', 'level', 'message']) AS shifted
  FROM head
), classified AS (
  SELECT *,
    CASE
      WHEN line IS NULL THEN 'empty_line'
      WHEN h.unix_s = '' THEN 'bgl_unrecognized_line'
      WHEN h.node <> '-' AND regular.node = h.node THEN 'regular'
      WHEN h.node = '-' AND shifted.source_type <> '' THEN 'shifted'
      WHEN h.node = '-' THEN 'bgl_corrupted_fields'
      ELSE 'bgl_node_mismatch'
    END AS layout
  FROM split
), fields AS (
  SELECT source_file, line_no, line, layout,
    h.label AS label,
    CASE layout WHEN 'regular' THEN NULLIF(h.node, 'NULL') END AS node,
    CASE layout WHEN 'regular' THEN regular.source_type ELSE shifted.source_type END AS source_type,
    CASE layout WHEN 'regular' THEN regular.component ELSE shifted.component END AS component,
    CASE layout WHEN 'regular' THEN regular.level ELSE shifted.level END AS level,
    CASE layout WHEN 'regular' THEN regular.message ELSE shifted.message END AS message,
    to_timestamp(NULLIF(h.unix_s, '')::BIGINT)
      + to_microseconds(NULLIF(h.micros, '')::BIGINT) AS ts,
    -- Offset of the local text time, for the time-base check only.
    to_timestamp(NULLIF(h.unix_s, '')::BIGINT)
      - try_strptime(h.ts_text, '%Y-%m-%d-%H.%M.%S')::TIMESTAMPTZ AS local_offset
  FROM classified
  WHERE layout IN ('regular', 'shifted')
)
SELECT
  source_file, line_no, line,
  CASE WHEN local_offset IS NULL THEN 'bgl_invalid_timestamp' END AS reject_reason,
  layout,
  ts,
  local_offset,
  level,
  component,
  NULLIF(NULLIF(source_type, ''), 'NULL') AS source_type,
  node,
  NULLIF(regexp_extract(node, '^(R\d{2})(?:-|$)', 1), '') AS rack,
  NULLIF(regexp_extract(node, '^(R\d{2}-M\d)(?:-|$)', 1), '') AS midplane,
  NULLIF(label, '-') AS alert_label,
  label <> '-' AS is_alert,
  -- R-02, confirmed by profiling (U03, sql/profiling/10_levels.sql): six
  -- levels occur (INFO, WARNING, SEVERE, ERROR, FATAL, FAILURE); the four
  -- below are errors, and every alert line has one of them. Levels are taken
  -- as logged, also where the text reads benign.
  level IN ('ERROR', 'SEVERE', 'FATAL', 'FAILURE') AS is_error,
  message
FROM fields
UNION ALL
SELECT source_file, line_no, line, layout AS reject_reason, layout,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
FROM classified
WHERE layout NOT IN ('regular', 'shifted');
