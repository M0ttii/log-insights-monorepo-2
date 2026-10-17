-- Plausibility and balance checks of a load run. src/load.ts prints every row
-- and fails the run (no manifest) if any check is not ok. Expected values are
-- independent of the parsing rules wherever possible: regex counts on the
-- message instead of the parsed column, base-table counts instead of index
-- counts.
CREATE OR REPLACE TABLE load_checks AS
WITH
offsets AS (
  SELECT local_offset, count(*) AS n FROM stage_bgl
  WHERE reject_reason IS NULL GROUP BY local_offset
),
api_lines AS (
  SELECT count(*) AS n FROM log_events
  WHERE dataset = 'openstack'
    AND regexp_matches(message, '" status: \d{3} len: \d+ time: [0-9.]+$')
),
file_ranges AS (
  SELECT f.file_ord, min(e.event_id) AS first_id, max(e.event_id) AS last_id
  FROM log_events e
  JOIN stage_files_openstack f USING (source_file)
  WHERE e.dataset = 'openstack'
  GROUP BY f.file_ord
),
-- Full-text visibility: index count vs. an independent word-boundary regex
-- on the base table, for a known term per dataset, alone and with a time
-- filter on the first half of the dataset's span.
-- The term must be a literal: @@ does not accept a column of another table.
spans AS (
  SELECT dataset, min(ts) + (max(ts) - min(ts)) / 2 AS mid FROM log_events GROUP BY dataset
),
visibility AS (
  SELECT 'bgl' AS dataset, 'parity' AS term,
    (SELECT count(*) FROM log_events_idx
      WHERE message @@ 'parity' AND dataset = 'bgl') AS index_count,
    (SELECT count(*) FROM log_events
      WHERE dataset = 'bgl'
        AND regexp_matches(lower(message), '(^|[^a-z0-9_])parity([^a-z0-9_]|$)')) AS base_count,
    (SELECT count(*) FROM log_events_idx
      WHERE message @@ 'parity' AND dataset = 'bgl'
        AND ts < (SELECT mid FROM spans WHERE dataset = 'bgl')) AS index_window,
    (SELECT count(*) FROM log_events
      WHERE dataset = 'bgl' AND ts < (SELECT mid FROM spans WHERE dataset = 'bgl')
        AND regexp_matches(lower(message), '(^|[^a-z0-9_])parity([^a-z0-9_]|$)')) AS base_window
  UNION ALL
  SELECT 'openstack', 'image',
    (SELECT count(*) FROM log_events_idx
      WHERE message @@ 'image' AND dataset = 'openstack'),
    (SELECT count(*) FROM log_events
      WHERE dataset = 'openstack'
        AND regexp_matches(lower(message), '(^|[^a-z0-9_])image([^a-z0-9_]|$)')),
    (SELECT count(*) FROM log_events_idx
      WHERE message @@ 'image' AND dataset = 'openstack'
        AND ts < (SELECT mid FROM spans WHERE dataset = 'openstack')),
    (SELECT count(*) FROM log_events
      WHERE dataset = 'openstack' AND ts < (SELECT mid FROM spans WHERE dataset = 'openstack')
        AND regexp_matches(lower(message), '(^|[^a-z0-9_])image([^a-z0-9_]|$)'))
),
empty_strings AS (
  SELECT count(*) AS n FROM log_events
  WHERE '' IN (level, component, source_type, node, rack, midplane, alert_label,
    request_id, user_id, tenant_id, instance_id, http_method, http_path, endpoint,
    pattern_id)
)
SELECT check_name, expected, observed, ok FROM (
  SELECT 1 AS ord, 'load_report: lines_read = events_loaded + rejected for every file' AS check_name,
    'all files' AS expected,
    count(*) FILTER (WHERE lines_read <> events_loaded + rejected)::VARCHAR || ' file(s) differ' AS observed,
    count(*) FILTER (WHERE lines_read <> events_loaded + rejected) = 0 AS ok
  FROM load_report
  UNION ALL
  SELECT 2, 'log_events per dataset = sum of events_loaded',
    (SELECT string_agg(dataset || ' ' || n, ', ' ORDER BY dataset) FROM
      (SELECT dataset, sum(events_loaded)::BIGINT AS n FROM load_report GROUP BY dataset)),
    (SELECT string_agg(dataset || ' ' || n, ', ' ORDER BY dataset) FROM
      (SELECT dataset, count(*) AS n FROM log_events GROUP BY dataset)),
    (SELECT string_agg(dataset || ' ' || n, ', ' ORDER BY dataset) FROM
      (SELECT dataset, sum(events_loaded)::BIGINT AS n FROM load_report GROUP BY dataset))
    = (SELECT string_agg(dataset || ' ' || n, ', ' ORDER BY dataset) FROM
      (SELECT dataset, count(*) AS n FROM log_events GROUP BY dataset))
  UNION ALL
  SELECT 3, 'event_id is unique and dataset, ts and message are set',
    '0 duplicates, 0 missing',
    (count(*) - count(DISTINCT event_id))::VARCHAR || ' duplicates, '
      || count(*) FILTER (WHERE dataset IS NULL OR ts IS NULL OR message IS NULL) || ' missing',
    count(*) = count(DISTINCT event_id)
      AND count(*) FILTER (WHERE dataset IS NULL OR ts IS NULL OR message IS NULL) = 0
  FROM log_events
  UNION ALL
  SELECT 4, 'BGL text time is US Pacific local time (Unix seconds minus 7 h or 8 h)',
    'only 07:00:00 and 08:00:00',
    coalesce(string_agg(local_offset::VARCHAR || ' x' || n, ', ' ORDER BY local_offset), 'no BGL events'),
    count(*) FILTER (WHERE local_offset NOT IN (INTERVAL '7 hours', INTERVAL '8 hours')) = 0
  FROM offsets
  UNION ALL
  SELECT 5, 'OpenStack event IDs ascend with the declared file order',
    'no overlap', count(*) FILTER (WHERE first_id <= prev_last)::VARCHAR || ' overlap(s)',
    count(*) FILTER (WHERE first_id <= prev_last) = 0
  FROM (SELECT *, lag(last_id) OVER (ORDER BY file_ord) AS prev_last FROM file_ranges)
  UNION ALL
  SELECT 6, 'pattern_id is collision-free',
    (SELECT count(*) FROM (SELECT DISTINCT dataset, component, pattern FROM log_events))::VARCHAR || ' patterns',
    (SELECT count(DISTINCT pattern_id) FROM log_events)::VARCHAR || ' pattern IDs',
    (SELECT count(*) FROM (SELECT DISTINCT dataset, component, pattern FROM log_events))
      = (SELECT count(DISTINCT pattern_id) FROM log_events)
  UNION ALL
  SELECT 7, 'absent fields are NULL, never the empty string',
    '0 rows', n::VARCHAR || ' rows', n = 0
  FROM empty_strings
  UNION ALL
  SELECT 8, 'api_access = OpenStack lines whose message ends in an HTTP access record (regex)',
    a.n::VARCHAR, (SELECT count(*) FROM api_access)::VARCHAR,
    a.n = (SELECT count(*) FROM api_access)
  FROM api_lines a
  UNION ALL
  SELECT 9, 'full-text index: @@ ''' || term || ''' = regex count (' || dataset || ')',
    base_count::VARCHAR || ', first half ' || base_window,
    index_count::VARCHAR || ', first half ' || index_window,
    index_count = base_count AND index_window = base_window AND base_count > 0
  FROM visibility
  UNION ALL
  SELECT 10, 'ownership has one team per component',
    '0 duplicates',
    (count(*) - count(DISTINCT (dataset, component)))::VARCHAR || ' duplicates',
    count(*) = count(DISTINCT (dataset, component))
  FROM ownership
  UNION ALL
  -- Not a failure: unowned components are allowed and reported (A-03).
  SELECT 11, 'observed components without a team are counted as unowned',
    'listed',
    coalesce(string_agg(dataset || ':' || coalesce(component, 'NULL'), ', ' ORDER BY dataset, component), 'none'),
    true
  FROM component_teams WHERE is_unowned
  UNION ALL
  SELECT 12, 'every labelled instance occurs in log_events',
    (SELECT count(*) FROM stage_openstack_labels)::VARCHAR,
    (SELECT count(DISTINCT instance_id) FROM log_events WHERE is_anomalous)::VARCHAR,
    (SELECT count(*) FROM stage_openstack_labels)
      = (SELECT count(DISTINCT instance_id) FROM log_events WHERE is_anomalous)
  UNION ALL
  SELECT 13, 'is_error is set wherever level is set',
    '0 rows',
    count(*)::VARCHAR || ' rows',
    count(*) = 0
  FROM log_events WHERE level IS NOT NULL AND is_error IS NULL
)
ORDER BY ord;
