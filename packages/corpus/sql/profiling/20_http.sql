-- OpenStack API accesses (concept R-01, R-02, O-06, A-12). Denominator of
-- every rate is all API accesses (api_access view) in the stated scope.

-- @ HTTP status distribution of API accesses
SELECT http_status, count(*) AS accesses,
  count(*) FILTER (WHERE request_id IS NULL) AS without_request_id,
  round(100.0 * count(*) / sum(count(*)) OVER (), 3) AS pct
FROM api_access
GROUP BY http_status
ORDER BY http_status;

-- @ 4xx and 5xx with numerator and denominator (whole OpenStack span)
SELECT count(*) AS api_accesses,
  count(*) FILTER (WHERE http_status BETWEEN 500 AND 599) AS status_5xx,
  count(*) FILTER (WHERE http_status BETWEEN 400 AND 499) AS status_4xx,
  round(100.0 * count(*) FILTER (WHERE http_status BETWEEN 500 AND 599) / count(*), 4) AS pct_5xx,
  round(100.0 * count(*) FILTER (WHERE http_status BETWEEN 400 AND 499) / count(*), 4) AS pct_4xx,
  count(*) FILTER (WHERE request_id IS NULL) AS without_request_id,
  round(100.0 * count(*) FILTER (WHERE request_id IS NULL) / count(*), 3) AS pct_without_request_id,
  count(DISTINCT request_id) AS requests
FROM api_access;

-- @ API accesses per source file (normal vs. abnormal run)
SELECT source_file, count(*) AS accesses,
  count(*) FILTER (WHERE http_status BETWEEN 500 AND 599) AS status_5xx,
  count(*) FILTER (WHERE http_status BETWEEN 400 AND 499) AS status_4xx
FROM api_access
GROUP BY source_file
ORDER BY source_file;

-- @ The 5xx accesses verbatim
SELECT event_id, strftime(ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS ts, source_file,
  request_id, message
FROM api_access WHERE http_status BETWEEN 500 AND 599
ORDER BY ts, event_id;

-- @ 4xx accesses by endpoint and request ID presence
SELECT endpoint, http_method, http_status, request_id IS NULL AS without_request_id,
  count(*) AS accesses
FROM api_access WHERE http_status BETWEEN 400 AND 499
GROUP BY ALL
ORDER BY accesses DESC, endpoint, http_method, http_status, without_request_id;

-- @ Accesses without request ID: who logs them
SELECT component, source_type, endpoint, count(*) AS accesses
FROM api_access WHERE request_id IS NULL
GROUP BY ALL
ORDER BY accesses DESC, component, source_type, endpoint
LIMIT 20;

-- @ Endpoint normalisation: distinct endpoints, methods and statuses
SELECT endpoint, http_method,
  string_agg(DISTINCT http_status::VARCHAR, ',' ORDER BY http_status::VARCHAR) AS statuses,
  count(*) AS accesses,
  count(DISTINCT http_path) AS distinct_paths,
  round(quantile_cont(latency_ms, 0.5), 1) AS p50_ms,
  round(quantile_cont(latency_ms, 0.99), 1) AS p99_ms,
  round(max(latency_ms), 1) AS max_ms
FROM api_access
GROUP BY endpoint, http_method
ORDER BY accesses DESC, endpoint, http_method;

-- @ Endpoints that still contain an ID-like segment (expected: none)
-- Any run of 8+ hex digits or digits outside a placeholder.
SELECT endpoint, count(*) AS accesses
FROM api_access
WHERE regexp_matches(regexp_replace(endpoint, '<[A-Z]+>', '', 'g'), '[0-9a-fA-F]{8,}|/\d+(/|$)')
GROUP BY endpoint
ORDER BY accesses DESC, endpoint;

-- @ Paths with a query string, by endpoint
SELECT endpoint, count(*) AS accesses
FROM api_access WHERE contains(http_path, '?')
GROUP BY endpoint
ORDER BY accesses DESC, endpoint;

-- @ Latency percentiles over all API accesses (ms)
SELECT count(*) AS accesses,
  round(quantile_cont(latency_ms, 0.5), 1) AS p50,
  round(quantile_cont(latency_ms, 0.9), 1) AS p90,
  round(quantile_cont(latency_ms, 0.95), 1) AS p95,
  round(quantile_cont(latency_ms, 0.99), 1) AS p99,
  round(max(latency_ms), 1) AS max
FROM api_access;

-- @ Slowest API accesses
SELECT event_id, strftime(ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS ts, endpoint,
  http_method, http_status, round(latency_ms, 1) AS latency_ms
FROM api_access
ORDER BY latency_ms DESC, event_id
LIMIT 15;
