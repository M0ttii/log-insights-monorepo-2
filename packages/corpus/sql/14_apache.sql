-- Apache error log fields (technical.md § 7.1, concept 5.5). Profiled on the
-- full file Apache.log (18.10.2026): 56,482 lines.
--
-- Line layout:
--   [Thu Jun 09 06:07:04 2005] [notice] LDAP: Built with OpenLDAP LDAP SDK
--   [Sat Jul 02 07:14:31 2005] [error] [client 61.10.7.143] Directory index forbidden by rule: /var/www/html/
-- Observed: levels error 38,081, notice 13,755, warn 168 (lower case, kept as
-- logged); 31,115 lines with a [client <IPv4>] block. 4,478 lines are the
-- bare text "script not found or unable to stat" without timestamp or level
-- (continuations of a "[client …] script not found or unable to stat: …"
-- line, in 1,500 runs); their time is unknown, so they are rejected as
-- apache_missing_header instead of borrowing a neighbour's time.
--
-- The file is the error log of one httpd server and names no module per
-- line, so component is httpd for every line.
--
-- Time (R-03): whole seconds without a zone; assumed UTC. The weekday in the
-- text is kept for 90_checks.sql, which compares it with the parsed date.
CREATE OR REPLACE TABLE stage_apache AS
WITH head AS (
  SELECT l.source_file, l.line_no, l.line,
    f.lines_before + l.line_no AS seq,
    regexp_extract(l.line,
      '^\[([A-Z][a-z]{2}) ([A-Z][a-z]{2}) (\d{2}) (\d{2}:\d{2}:\d{2}) (\d{4})\] \[([a-z]+)\] (?:\[client ([^\]]+)\] )?(.*)$',
      ['weekday', 'mon', 'day', 'time', 'year', 'level', 'client', 'message']) AS h
  FROM stage_lines_apache l
  JOIN stage_files_apache f USING (filename)
), fields AS (
  SELECT *,
    try_strptime(h.mon || ' ' || h.day || ' ' || h.time || ' ' || h.year
      || ' +0000', '%b %d %H:%M:%S %Y %z') AS ts
  FROM head
)
SELECT
  source_file, line_no, line, seq,
  CASE
    WHEN line IS NULL THEN 'empty_line'
    WHEN h.mon = '' THEN 'apache_missing_header'
    WHEN ts IS NULL THEN 'apache_invalid_timestamp'
  END AS reject_reason,
  ts,
  NULLIF(h.level, '') AS level,
  CASE WHEN h.mon <> '' THEN 'httpd' END AS component,
  NULL::VARCHAR AS source_type,
  NULL::VARCHAR AS host,
  NULL::VARCHAR AS process_id,
  NULLIF(h.client, '') AS client_ip,
  NULL::VARCHAR AS thread,
  NULL::VARCHAR AS block_id,
  -- R-02 (U26): Apache levels error and above; warn and notice are not.
  NULLIF(h.level, '') IN ('error', 'crit', 'alert', 'emerg') AS is_error,
  NULL::BOOLEAN AS is_anomalous,
  h.message AS message,
  NULLIF(h.weekday, '') AS weekday_text
FROM fields;
