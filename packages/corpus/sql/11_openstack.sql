-- OpenStack fields (technical.md § 6.1, concept § 5.1). Profiled on the full
-- corpus (17.10.2026).
--
-- Line layout: log file name (service prefix), date and time with
-- milliseconds, PID, level, logger, request block, message:
--   nova-api.log.1.2017-05-16_13:53:08 2017-05-16 00:00:00.008 25746 INFO nova.osapi_compute.wsgi.server [req-<uuid> <user> <tenant> - - -] 10.11.10.1 "GET /v2/<tenant>/servers/detail HTTP/1.1" status: 200 len: 1893 time: 0.2477829
-- Variants observed:
--   * `[req-… - - - - -]` without user and tenant; `-` becomes NULL.
--   * `[-]` without request ID (metadata service, 15,462 lines).
--   * No request block (184 lines: traceback continuation lines and 8 lines
--     without message text); the message is the rest of the line.
--   * API access lines (98,733): `"<method> <path> HTTP/1.1" status: <code>
--     len: <bytes> time: <seconds>` at the end of the message.
--
-- Time (R-03): the timestamp has no zone; it is taken as UTC.

-- Instance IDs with injected anomalies (dataset label, O-04). The file has a
-- sentence, a blank line and one UUID per line; only UUID lines count.
-- {{OPENSTACK_LABELS}} reads it, or is an empty set for sources without it.
CREATE OR REPLACE TABLE stage_openstack_labels AS
SELECT DISTINCT lower(trim(line)) AS instance_id
FROM {{OPENSTACK_LABELS}}
WHERE regexp_matches(trim(line),
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');

CREATE OR REPLACE TABLE stage_openstack AS
WITH head AS (
  SELECT l.source_file, l.line_no, l.line,
    f.lines_before + l.line_no AS seq,
    regexp_extract(l.line,
      '^(\S+) (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) (\d+) (\S+) (\S+)(?: (.*))?$',
      ['log_file', 'ts_text', 'pid', 'level', 'logger', 'rest']) AS h
  FROM stage_lines_openstack l
  JOIN stage_files_openstack f USING (filename)
), block AS (
  SELECT *,
    regexp_extract(h.rest,
      '^\[(req-[0-9a-f-]+) (\S+) (\S+) \S+ \S+ \S+\](?: (.*))?$',
      ['request_id', 'user_id', 'tenant_id', 'message']) AS req,
    regexp_extract(h.rest, '^\[-\](?: (.*))?$', ['message']) AS anon,
    starts_with(h.rest, '[-]') AS is_anonymous
  FROM head
), fields AS (
  SELECT source_file, line_no, line, seq,
    CASE
      WHEN line IS NULL THEN 'empty_line'
      WHEN h.ts_text = '' THEN 'openstack_unrecognized_line'
      WHEN TRY_CAST(h.ts_text || 'Z' AS TIMESTAMPTZ) IS NULL THEN 'openstack_invalid_timestamp'
    END AS reject_reason,
    TRY_CAST(h.ts_text || 'Z' AS TIMESTAMPTZ) AS ts,
    NULLIF(h.level, '') AS level,
    NULLIF(regexp_extract(h.log_file, '^([a-z][a-z-]*)\.log', 1), '') AS component,
    NULLIF(h.logger, '') AS source_type,
    NULLIF(req.request_id, '') AS request_id,
    NULLIF(NULLIF(req.user_id, ''), '-') AS user_id,
    NULLIF(NULLIF(req.tenant_id, ''), '-') AS tenant_id,
    CASE
      WHEN req.request_id <> '' THEN req.message
      WHEN is_anonymous THEN anon.message
      ELSE h.rest
    END AS message
  FROM block
), api AS (
  SELECT *,
    NULLIF(regexp_extract(message, '\[instance: ([0-9a-f-]{36})\]', 1), '') AS instance_id,
    regexp_extract(message,
      '"(\S+) (\S+) HTTP/\d\.\d" status: (\d{3}) len: (\d+) time: (\d+(?:\.\d+)?)$',
      ['method', 'path', 'status', 'bytes', 'seconds']) AS http
  FROM fields
)
SELECT
  source_file, line_no, line, seq, reject_reason, ts, level, component,
  source_type, request_id, user_id, tenant_id, instance_id,
  NULLIF(http.method, '') AS http_method,
  NULLIF(http.path, '') AS http_path,
  -- Endpoint = path without query string, IDs and numeric segments masked
  -- (R-04: variable path segments only, not the whole path).
  CASE WHEN http.path <> '' THEN
    regexp_replace(
      regexp_replace(
        regexp_replace(split_part(http.path, '?', 1),
          '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
          '<UUID>', 'g'),
        '/[0-9a-f]{32}(/|$)', '/<ID>\1', 'g'),
      '/\d+(/|$)', '/<NUM>\1', 'g')
  END AS endpoint,
  NULLIF(http.status, '')::INTEGER AS http_status,
  NULLIF(http.bytes, '')::BIGINT AS response_bytes,
  -- Seconds with up to 7 decimals; DECIMAL keeps the conversion exact.
  (NULLIF(http.seconds, '')::DECIMAL(18, 7) * 1000)::DOUBLE AS latency_ms,
  -- R-02, confirmed by profiling (U03): INFO, WARNING, ERROR and CRITICAL
  -- occur; ERROR and CRITICAL are errors.
  level IN ('ERROR', 'CRITICAL') AS is_error,
  -- Dataset label by instance ID: NULL where the line names no instance or
  -- the source has no labels, never false by default.
  CASE WHEN {{OPENSTACK_LABELS_AVAILABLE}} AND instance_id IS NOT NULL
    THEN instance_id IN (SELECT instance_id FROM stage_openstack_labels)
  END AS is_anomalous,
  message
FROM api;
