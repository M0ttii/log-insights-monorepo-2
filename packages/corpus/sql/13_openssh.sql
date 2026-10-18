-- OpenSSH fields (technical.md § 7.1, concept 5.5). Profiled on the full
-- file SSH.log (18.10.2026): 655,147 lines, all from host LabSZ, program
-- sshd with a PID.
--
-- Line layout (syslog without year):
--   Dec 10 06:55:46 LabSZ sshd[24200]: Invalid user webmaster from 173.234.31.186
--
-- Time (R-03): no year and no zone. The file runs from 10 December to
-- 7 January with exactly one month wrap (December -> January after line
-- 302,277); the archive entry SSH.log is dated 2018-01-07 and Loghub reports
-- 28+ days. December is therefore 2017 and the lines after the wrap 2018:
-- year = 2017 + number of month wraps up to the line. 90_checks.sql fails a
-- load with more than one wrap. Times are taken as UTC (time_basis says so).
--
-- No level field. R-02 (U26): OpenSSH prefixes messages of its levels ERROR
-- and FATAL with "error: " and "fatal: " (log.c, do_log); those are errors.
--
-- client_ip: the IPv4 address of the remote side in the fixed message forms
-- "[ip]" (reverse mapping), "from ip", "by ip", "rhost=ip", "Address ip".
-- A host name (rhost=host.example) is no address and stays NULL.
CREATE OR REPLACE TABLE stage_openssh AS
WITH head AS (
  SELECT l.source_file, l.line_no, l.line,
    f.lines_before + l.line_no AS seq,
    regexp_extract(l.line,
      '^([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}:\d{2}:\d{2}) (\S+) ([^\[\s:]+)\[(\d+)\]: ?(.*)$',
      ['mon', 'day', 'time', 'host', 'program', 'pid', 'message']) AS h
  FROM stage_lines_openssh l
  JOIN stage_files_openssh f USING (filename)
), months AS (
  SELECT *,
    list_position(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug',
      'Sep', 'Oct', 'Nov', 'Dec'], NULLIF(h.mon, '')) AS month_no
  FROM head
), wrapped AS (
  SELECT *,
    coalesce(sum(CASE WHEN month_no < prev_month THEN 1 ELSE 0 END)
      OVER (ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0) AS year_wraps
  FROM (
    SELECT *, lag(month_no) OVER (ORDER BY seq) AS prev_month
    FROM months WHERE month_no IS NOT NULL
  )
  UNION ALL
  SELECT *, NULL::INTEGER AS prev_month, NULL::BIGINT AS year_wraps
  FROM months WHERE month_no IS NULL
), fields AS (
  SELECT source_file, line_no, line, seq, year_wraps,
    try_strptime((2017 + year_wraps)::VARCHAR || ' ' || h.mon || ' ' || h.day
      || ' ' || h.time || ' +0000', '%Y %b %d %H:%M:%S %z') AS ts,
    h
  FROM wrapped
)
SELECT
  source_file, line_no, line, seq,
  CASE
    WHEN line IS NULL THEN 'empty_line'
    WHEN h.mon = '' THEN 'openssh_unrecognized_line'
    WHEN ts IS NULL THEN 'openssh_invalid_timestamp'
  END AS reject_reason,
  ts,
  NULL::VARCHAR AS level,
  NULLIF(h.program, '') AS component,
  NULL::VARCHAR AS source_type,
  NULLIF(h.host, '') AS host,
  NULLIF(h.pid, '') AS process_id,
  coalesce(
    NULLIF(regexp_extract(h.message, '\[(\d{1,3}(?:\.\d{1,3}){3})\]', 1), ''),
    NULLIF(regexp_extract(h.message,
      '(?:\bfrom |\bby |rhost=|^Address )(\d{1,3}(?:\.\d{1,3}){3})\b', 1), '')
  ) AS client_ip,
  NULL::VARCHAR AS thread,
  NULL::VARCHAR AS block_id,
  CASE WHEN h.mon <> '' THEN
    starts_with(h.message, 'error: ') OR starts_with(h.message, 'fatal: ')
  END AS is_error,
  NULL::BOOLEAN AS is_anomalous,
  h.message AS message,
  year_wraps
FROM fields;
