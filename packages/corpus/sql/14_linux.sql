-- Linux syslog fields (technical.md § 7.1, concept 5.5). Profiled on the
-- full file Linux.log (18.10.2026): 25,567 lines, all from host combo.
--
-- Line layout (syslog without year):
--   Jun 14 15:16:01 combo sshd(pam_unix)[19939]: authentication failure; logname= uid=0 …
--   Jun  9 06:06:20 combo syslogd 1.4.1: restart.
--   Sep 28 09:08:56 combo last message repeated 2 times
-- The program is the text before the first ":" (with an optional [pid]),
-- kept as logged, including "syslogd 1.4.1" and "-- root". 18 lines have no
-- program ("last message repeated …", "exiting on signal 15"): component
-- NULL, the message is the rest of the line. 20 lines contain invalid UTF-8
-- (format-string attacks on rpc.statd); read_csv rejects them
-- (05_read.sql) and they are kept with their reason in load_rejects.
--
-- Time (R-03): no year and no zone. The file runs from June to February
-- with exactly one month wrap; ftpd lines name the full date
-- ("connection from … at Sat Jun 11 03:28:22 2005"; June–December 2005,
-- January–February 2006). year = 2005 + number of month wraps up to the line;
-- 90_checks.sql compares every such ftpd date with its header and fails a
-- load with more than one wrap. Times are taken as UTC (time_basis says so).
--
-- No level and no error marker: is_error is NULL (unknown, R-02), not false.
CREATE OR REPLACE TABLE stage_linux AS
WITH head AS (
  SELECT l.source_file, l.line_no, l.line,
    f.lines_before + l.line_no AS seq,
    regexp_extract(l.line,
      '^([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}:\d{2}:\d{2}) (\S+) (.*)$',
      ['mon', 'day', 'time', 'host', 'rest']) AS h
  FROM stage_lines_linux l
  JOIN stage_files_linux f USING (filename)
), program AS (
  SELECT *,
    regexp_extract(h.rest, '^ *([^\[:]*[^\[:\s])(?:\[(\d+)\])?: ?(.*)$',
      ['program', 'pid', 'message']) AS p
  FROM head
), months AS (
  SELECT *,
    list_position(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug',
      'Sep', 'Oct', 'Nov', 'Dec'], NULLIF(h.mon, '')) AS month_no
  FROM program
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
  SELECT source_file, line_no, line, seq, year_wraps, h, p,
    try_strptime((2005 + year_wraps)::VARCHAR || ' ' || h.mon || ' ' || h.day
      || ' ' || h.time || ' +0000', '%Y %b %d %H:%M:%S %z') AS ts,
    CASE WHEN p.program <> '' THEN p.message ELSE h.rest END AS message
  FROM wrapped
)
SELECT
  source_file, line_no, line, seq,
  CASE
    WHEN line IS NULL THEN 'empty_line'
    WHEN h.mon = '' THEN 'linux_unrecognized_line'
    WHEN ts IS NULL THEN 'linux_invalid_timestamp'
  END AS reject_reason,
  ts,
  NULL::VARCHAR AS level,
  NULLIF(p.program, '') AS component,
  NULL::VARCHAR AS source_type,
  NULLIF(h.host, '') AS host,
  NULLIF(p.pid, '') AS process_id,
  NULL::VARCHAR AS client_ip,
  NULL::VARCHAR AS thread,
  NULL::VARCHAR AS block_id,
  NULL::BOOLEAN AS is_error,
  NULL::BOOLEAN AS is_anomalous,
  message,
  year_wraps,
  -- Full date that ftpd writes into the message, for the year check.
  NULLIF(regexp_extract(message,
    ' at [A-Z][a-z]{2} ([A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s*$', 1), '') AS message_date
FROM fields;
