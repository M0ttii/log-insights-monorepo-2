-- log_events (technical.md § 6.1): one wide table for both datasets, fields
-- of the other dataset NULL. Only accepted lines; rejected ones are in
-- load_rejects. CREATE OR REPLACE TABLE drops a dependent inverted index
-- without notice and fails while a view depends on the table (gate G3), so
-- 01_schema.sql drops the views first; 40_stats.sql and 50_index.sql
-- recreate views and index.
--
-- event_id: BGL = line number; OpenStack = 10,000,000 + running line number
-- over the files in their fixed order (stage_files_openstack.lines_before).
-- pattern_id: first 16 hex digits of MD5 over dataset, component and pattern,
-- separated by the unit separator; 90_checks.sql verifies it is collision-free.
-- No episode gaps are precomputed: they depend on the filtered scope (R-05).
CREATE OR REPLACE TABLE log_events AS
WITH events AS (
  SELECT
    line_no AS event_id, 'bgl' AS dataset, source_file, line_no, ts, level,
    component, source_type, node, rack, midplane, alert_label, is_alert,
    is_error,
    NULL::VARCHAR AS request_id, NULL::VARCHAR AS user_id,
    NULL::VARCHAR AS tenant_id, NULL::VARCHAR AS instance_id,
    NULL::VARCHAR AS http_method, NULL::VARCHAR AS http_path,
    NULL::VARCHAR AS endpoint, NULL::INTEGER AS http_status,
    NULL::BIGINT AS response_bytes, NULL::DOUBLE AS latency_ms,
    NULL::BOOLEAN AS is_anomalous,
    message
  FROM stage_bgl WHERE reject_reason IS NULL
  UNION ALL
  SELECT
    10000000 + seq, 'openstack', source_file, line_no, ts, level,
    component, source_type, NULL, NULL, NULL, NULL, NULL,
    is_error,
    request_id, user_id, tenant_id, instance_id,
    http_method, http_path, endpoint, http_status, response_bytes, latency_ms,
    is_anomalous,
    message
  FROM stage_openstack WHERE reject_reason IS NULL
), patterned AS (
  SELECT *, log_pattern(dataset, message) AS pattern FROM events
)
SELECT
  event_id::BIGINT AS event_id, dataset, source_file, line_no::BIGINT AS line_no,
  ts, level, component, source_type, node, rack, midplane, alert_label,
  is_alert, is_error, request_id, user_id, tenant_id, instance_id,
  http_method, http_path, endpoint, http_status, response_bytes, latency_ms,
  is_anomalous, message, pattern,
  left(md5(dataset || chr(31) || coalesce(component, '') || chr(31) || pattern), 16) AS pattern_id
FROM patterned
ORDER BY event_id;
