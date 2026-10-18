-- ZooKeeper fields (technical.md § 7.1, concept 5.5). Profiled on the full
-- file Zookeeper.log (18.10.2026): 74,380 lines, every one with this header.
--
-- Line layout (log4j):
--   2015-07-29 17:41:41,536 - INFO  [main:QuorumPeerConfig@101] - Reading configuration from: /etc/zookeeper/conf/zoo.cfg
--   2015-07-29 19:04:12,394 - INFO  [/10.10.34.11:3888:QuorumCnxManager$Listener@493] - Received connection request /10.10.34.11:45307
-- The bracket holds thread:Class@line. Thread names contain colons
-- (QuorumPeer[myid=1]/0:0:0:0:0:0:0:0:2181), so the thread is everything up
-- to the last ":" before Class@line. The source line number is dropped.
-- Observed: WARN 48,507, INFO 25,256, ERROR 617; 30 classes.
--
-- Time (R-03): milliseconds without a zone; assumed UTC. The log aggregates
-- three servers (myid 1–3) one after another, so times jump back at the
-- start of each server's part; event_id keeps the file order, ts the time.
CREATE OR REPLACE TABLE stage_zookeeper AS
WITH head AS (
  SELECT l.source_file, l.line_no, l.line,
    f.lines_before + l.line_no AS seq,
    regexp_extract(l.line,
      '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),(\d{3}) - ([A-Z]+) +\[(.*):([A-Za-z0-9_$]+)@(\d+)\] - (.*)$',
      ['ts_text', 'millis', 'level', 'thread', 'component', 'source_line', 'message']) AS h
  FROM stage_lines_zookeeper l
  JOIN stage_files_zookeeper f USING (filename)
), fields AS (
  SELECT *,
    try_strptime(h.ts_text || '.' || h.millis || ' +0000',
      '%Y-%m-%d %H:%M:%S.%g %z') AS ts
  FROM head
)
SELECT
  source_file, line_no, line, seq,
  CASE
    WHEN line IS NULL THEN 'empty_line'
    WHEN h.ts_text = '' THEN 'zookeeper_unrecognized_line'
    WHEN ts IS NULL THEN 'zookeeper_invalid_timestamp'
  END AS reject_reason,
  ts,
  NULLIF(h.level, '') AS level,
  NULLIF(h.component, '') AS component,
  NULL::VARCHAR AS source_type,
  NULL::VARCHAR AS host,
  NULL::VARCHAR AS process_id,
  NULL::VARCHAR AS client_ip,
  NULLIF(h.thread, '') AS thread,
  NULL::VARCHAR AS block_id,
  -- R-02 (U26): log4j error levels; WARN is a warning, not an error.
  NULLIF(h.level, '') IN ('ERROR', 'FATAL') AS is_error,
  NULL::BOOLEAN AS is_anomalous,
  h.message AS message
FROM fields;
