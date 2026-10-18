-- HDFS_v1 fields (technical.md § 7.1, concept 5.5). Profiled on the full
-- file (18.10.2026): 11,175,629 lines, every one with this header.
--
-- Line layout: date yymmdd, time HHMMSS, a number Loghub calls "Pid", level,
-- Java class, message:
--   081109 203518 143 INFO dfs.DataNode$DataXceiver: Receiving block blk_-1608999687919862906 src: /10.250.19.102:54106 dest: /10.250.19.102:50010
-- Observed: levels INFO and WARN only (no ERROR or FATAL); every message
-- names a block ID, and in the full file exactly one (1,402,056 lines name
-- the same ID twice, "Deleting block blk_x file …/blk_x"). The Loghub 2k
-- sample is not a subset of the full file: 3 of its lines ask a datanode to
-- delete 9–100 different blocks. block_id is the one block a line names and
-- NULL for such lines, which belong to no single block.
--
-- The third header field is not stored: its meaning (process or thread) is
-- not documented, and it is not equated with process_id of the syslog
-- datasets.
--
-- Time (R-03): whole seconds without a zone; assumed UTC (time_basis says so).
--
-- Labels (dataset label): preprocessed/anomaly_label.csv labels every block
-- Normal or Anomaly (575,061 blocks). The placeholder below reads it, or is an
-- empty set for sources without it; is_anomalous stays NULL then.
CREATE OR REPLACE TABLE stage_hdfs_labels AS
SELECT "BlockId" AS block_id, "Label" AS label
FROM {{HDFS_LABELS}};

CREATE OR REPLACE TABLE stage_hdfs AS
WITH head AS (
  SELECT l.source_file, l.line_no, l.line,
    f.lines_before + l.line_no AS seq,
    regexp_extract(l.line,
      '^(\d{6} \d{6}) (\d+) ([A-Z]+) ([^\s:]+): (.*)$',
      ['ts_text', 'third', 'level', 'component', 'message']) AS h
  FROM stage_lines_hdfs l
  JOIN stage_files_hdfs f USING (filename)
), fields AS (
  SELECT source_file, line_no, line, seq,
    CASE
      WHEN line IS NULL THEN 'empty_line'
      WHEN h.ts_text = '' THEN 'hdfs_unrecognized_line'
      WHEN try_strptime(h.ts_text || ' +0000', '%y%m%d %H%M%S %z') IS NULL
        THEN 'hdfs_invalid_timestamp'
    END AS reject_reason,
    try_strptime(h.ts_text || ' +0000', '%y%m%d %H%M%S %z') AS ts,
    NULLIF(h.level, '') AS level,
    NULLIF(h.component, '') AS component,
    list_distinct(regexp_extract_all(h.message, 'blk_-?\d+')) AS blocks,
    h.message AS message
  FROM head
)
SELECT
  f.source_file, f.line_no, f.line, f.seq, f.reject_reason, f.ts, f.level,
  f.component,
  NULL::VARCHAR AS source_type,
  NULL::VARCHAR AS host,
  NULL::VARCHAR AS process_id,
  NULL::VARCHAR AS client_ip,
  NULL::VARCHAR AS thread,
  CASE WHEN len(f.blocks) = 1 THEN f.blocks[1] END AS block_id,
  -- R-02 (U26): log4j error levels; WARN is a warning, not an error.
  f.level IN ('ERROR', 'FATAL') AS is_error,
  -- Dataset label of the block: NULL without labels or for an unlabelled
  -- block, never false by default.
  CASE WHEN {{HDFS_LABELS_AVAILABLE}} THEN lb.label = 'Anomaly' END AS is_anomalous,
  f.message,
  len(f.blocks) AS block_count
FROM fields f
LEFT JOIN stage_hdfs_labels lb
  ON len(f.blocks) = 1 AND lb.block_id = f.blocks[1];
