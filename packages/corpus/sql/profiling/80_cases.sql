-- Case selection (concept 11.2) and the S-16 search. Episodes use the
-- confirmed threshold of 30 minutes (R-05) over the whole dataset span;
-- nodes and racks are the breadth levels decided in U03 (R-08). The first
-- assessment of the candidates was recorded before these queries ran
-- (Linear LOG-12, comment of 17.10.2026).

-- @ BGL alert categories (dataset labels): events, patterns, episodes, breadth, team
-- Episodes here are per alert category, not per pattern as in R-05; for the
-- three candidates each category is exactly one pattern (next query).
WITH e AS (
  SELECT alert_label, pattern_id, component, ts, event_id, node, rack,
    epoch(ts - lag(ts) OVER (PARTITION BY alert_label ORDER BY ts, event_id)) AS gap_s
  FROM log_events WHERE dataset = 'bgl' AND is_alert
)
SELECT e.alert_label, count(*) AS events, count(DISTINCT pattern_id) AS patterns,
  string_agg(DISTINCT e.component || '/' || coalesce(t.team, 'unowned'), ', ') AS teams,
  1 + count(*) FILTER (WHERE gap_s >= 1800) AS episodes,
  count(DISTINCT date_trunc('day', ts)) AS active_days,
  count(DISTINCT node) AS nodes, count(DISTINCT rack) AS racks,
  strftime(min(ts), '%Y-%m-%d') AS first_day, strftime(max(ts), '%Y-%m-%d') AS last_day
FROM e LEFT JOIN component_teams t ON t.dataset = 'bgl' AND t.component = e.component
GROUP BY e.alert_label
ORDER BY events DESC, e.alert_label
LIMIT 20;

-- @ Patterns of the candidate alert categories APPREAD, KERNDTLB, KERNSTOR
SELECT alert_label, pattern_id, component, pattern, count(*) AS events
FROM log_events
WHERE dataset = 'bgl' AND alert_label IN ('APPREAD', 'KERNDTLB', 'KERNSTOR')
GROUP BY ALL ORDER BY alert_label, events DESC, pattern_id;

-- @ APPREAD episodes: size, breadth and duration per episode
WITH e AS (
  SELECT ts, event_id, node, rack,
    CASE WHEN lag(ts) OVER (ORDER BY ts, event_id) IS NULL
      OR ts - lag(ts) OVER (ORDER BY ts, event_id) >= INTERVAL '30 minutes' THEN 1 ELSE 0 END AS starts
  FROM log_events WHERE dataset = 'bgl' AND alert_label = 'APPREAD'
), numbered AS (
  SELECT *, sum(starts) OVER (ORDER BY ts, event_id ROWS UNBOUNDED PRECEDING) AS episode FROM e
)
SELECT episode, strftime(min(ts), '%Y-%m-%dT%H:%M:%SZ') AS first_ts,
  round(epoch(max(ts) - min(ts)) / 60, 1) AS minutes, count(*) AS events,
  count(DISTINCT node) AS nodes, count(DISTINCT rack) AS racks
FROM numbered GROUP BY episode ORDER BY episode;

-- @ KERNDTLB episodes: size, breadth and duration per episode
WITH e AS (
  SELECT ts, event_id, node, rack,
    CASE WHEN lag(ts) OVER (ORDER BY ts, event_id) IS NULL
      OR ts - lag(ts) OVER (ORDER BY ts, event_id) >= INTERVAL '30 minutes' THEN 1 ELSE 0 END AS starts
  FROM log_events WHERE dataset = 'bgl' AND alert_label = 'KERNDTLB'
), numbered AS (
  SELECT *, sum(starts) OVER (ORDER BY ts, event_id ROWS UNBOUNDED PRECEDING) AS episode FROM e
)
SELECT episode, strftime(min(ts), '%Y-%m-%dT%H:%M:%SZ') AS first_ts,
  round(epoch(max(ts) - min(ts)) / 60, 1) AS minutes, count(*) AS events,
  count(DISTINCT node) AS nodes, count(DISTINCT rack) AS racks
FROM numbered GROUP BY episode ORDER BY episode;

-- @ KERNSTOR episodes: size, breadth and duration per episode
WITH e AS (
  SELECT ts, event_id, node, rack,
    CASE WHEN lag(ts) OVER (ORDER BY ts, event_id) IS NULL
      OR ts - lag(ts) OVER (ORDER BY ts, event_id) >= INTERVAL '30 minutes' THEN 1 ELSE 0 END AS starts
  FROM log_events WHERE dataset = 'bgl' AND alert_label = 'KERNSTOR'
), numbered AS (
  SELECT *, sum(starts) OVER (ORDER BY ts, event_id ROWS UNBOUNDED PRECEDING) AS episode FROM e
)
SELECT episode, strftime(min(ts), '%Y-%m-%dT%H:%M:%SZ') AS first_ts,
  round(epoch(max(ts) - min(ts)) / 60, 1) AS minutes, count(*) AS events,
  count(DISTINCT node) AS nodes, count(DISTINCT rack) AS racks
FROM numbered GROUP BY episode ORDER BY episode;

-- @ APPREAD: what happens in the 10 minutes before each episode start (R-11 sketch)
-- Anchors are APPREAD episode starts; per pattern the number of anchors
-- with at least one event in [anchor - 10 min, anchor); APPREAD lines
-- themselves excluded. Base rate: share of 10-minute grid windows from the
-- start of the BGL span in which the pattern occurs.
WITH a AS (
  SELECT ts FROM (
    SELECT ts, lag(ts) OVER (ORDER BY ts, event_id) AS prev
    FROM log_events WHERE dataset = 'bgl' AND alert_label = 'APPREAD')
  WHERE prev IS NULL OR ts - prev >= INTERVAL '30 minutes'
), hits AS (
  SELECT e.pattern_id, count(DISTINCT a.ts) AS anchors_with
  FROM a JOIN log_events e
    ON e.dataset = 'bgl' AND e.ts >= a.ts - INTERVAL '10 minutes' AND e.ts < a.ts
    AND e.alert_label IS DISTINCT FROM 'APPREAD'
  GROUP BY e.pattern_id
), span AS (
  SELECT min(ts) AS t0, max(ts) AS t1 FROM log_events WHERE dataset = 'bgl'
), grid AS (
  SELECT e.pattern_id, count(DISTINCT floor(epoch(e.ts - s.t0) / 600)) AS windows_with
  FROM log_events e, span s
  WHERE e.dataset = 'bgl' AND e.pattern_id IN (SELECT pattern_id FROM hits)
  GROUP BY e.pattern_id
)
SELECT h.pattern_id, any_value(l.component) AS component, left(any_value(l.pattern), 70) AS pattern,
  h.anchors_with, (SELECT count(*) FROM a) AS anchors,
  round(h.anchors_with / (SELECT count(*) FROM a)::DOUBLE, 3) AS anchor_share,
  round(g.windows_with / ceil(epoch((SELECT t1 - t0 FROM span)) / 600), 4) AS base_rate
FROM hits h JOIN grid g USING (pattern_id) JOIN log_events l USING (pattern_id)
GROUP BY h.pattern_id, h.anchors_with, g.windows_with
ORDER BY anchors_with DESC, h.pattern_id
LIMIT 12;

-- @ OpenStack: the 5xx minute and its neighbourhood (06:24–06:27 on 16 and 17 May)
SELECT strftime(date_trunc('day', ts), '%Y-%m-%d') AS day, component, level,
  left(pattern, 90) AS pattern, count(*) AS events
FROM log_events
WHERE dataset = 'openstack' AND level <> 'INFO'
  AND strftime(ts, '%H:%M') BETWEEN '06:24' AND '06:27'
GROUP BY ALL ORDER BY day, events DESC, pattern, component, level;

-- @ OpenStack: hourly API latency (all API accesses), with 5xx and errors per hour
SELECT strftime(date_trunc('hour', ts), '%Y-%m-%dT%H') AS hour, count(*) AS accesses,
  round(quantile_cont(latency_ms, 0.5), 1) AS p50, round(quantile_cont(latency_ms, 0.99), 1) AS p99,
  round(max(latency_ms), 1) AS max,
  count(*) FILTER (WHERE http_status BETWEEN 500 AND 599) AS status_5xx
FROM api_access GROUP BY ALL ORDER BY hour;

-- @ OpenStack: power state synchronisation warnings
SELECT left(pattern, 120) AS pattern, count(*) AS events,
  count(DISTINCT strftime(ts, '%Y-%m-%dT%H')) AS hours,
  strftime(min(ts), '%Y-%m-%dT%H:%M:%SZ') AS first_ts, strftime(max(ts), '%Y-%m-%dT%H:%M:%SZ') AS last_ts
FROM log_events
WHERE dataset = 'openstack' AND contains(lower(message), 'power state')
GROUP BY ALL ORDER BY events DESC, pattern;

-- @ S-16: BGL error/alert patterns, rank by events vs. rank by episodes (whole span)
WITH g AS (
  SELECT pattern_id, component, pattern, ts, node,
    epoch(ts - lag(ts) OVER (PARTITION BY pattern_id ORDER BY ts, event_id)) AS gap_s
  FROM log_events WHERE dataset = 'bgl' AND (is_error OR is_alert)
), p AS (
  SELECT pattern_id, any_value(component) AS component, left(any_value(pattern), 60) AS pattern,
    count(*) AS events, 1 + count(*) FILTER (WHERE gap_s >= 1800) AS episodes,
    count(DISTINCT node) AS nodes, count(node) = count(*) AS node_on_every_event
  FROM g GROUP BY pattern_id
)
SELECT *, row_number() OVER (ORDER BY events DESC, pattern_id) AS rank_by_events,
  row_number() OVER (ORDER BY episodes DESC, events DESC, pattern_id) AS rank_by_episodes
FROM p ORDER BY events DESC, pattern_id LIMIT 12;

-- @ S-16: top 8 by episodes (whole span) for comparison
WITH g AS (
  SELECT pattern_id, component, pattern, ts, node, rack,
    epoch(ts - lag(ts) OVER (PARTITION BY pattern_id ORDER BY ts, event_id)) AS gap_s
  FROM log_events WHERE dataset = 'bgl' AND (is_error OR is_alert)
)
SELECT pattern_id, any_value(component) AS component, left(any_value(pattern), 60) AS pattern,
  count(*) AS events, 1 + count(*) FILTER (WHERE gap_s >= 1800) AS episodes,
  count(DISTINCT node) AS nodes, count(DISTINCT rack) AS racks
FROM g GROUP BY pattern_id
ORDER BY episodes DESC, events DESC, pattern_id LIMIT 8;

-- @ Capture gaps: dataset-level breaks of 6 hours or more (no event at all)
WITH g AS (
  SELECT dataset, ts, lag(ts) OVER (PARTITION BY dataset ORDER BY ts, event_id) AS prev
  FROM log_events
)
SELECT dataset, strftime(prev, '%Y-%m-%dT%H:%M:%SZ') AS from_ts, strftime(ts, '%Y-%m-%dT%H:%M:%SZ') AS to_ts,
  round(epoch(ts - prev) / 3600, 1) AS hours
FROM g WHERE ts - prev >= INTERVAL '6 hours'
ORDER BY hours DESC, dataset, from_ts LIMIT 20;

-- @ APPREAD: the chdir precursor per episode, and whether it names the same I/O nodes
-- Precursor = "ciod: LOGIN chdir(<PATH>) failed" in [start - 10 min, start).
WITH ep AS (
  SELECT ts, event_id, sum(starts) OVER (ORDER BY ts, event_id ROWS UNBOUNDED PRECEDING) AS episode, node
  FROM (
    SELECT ts, event_id, node,
      CASE WHEN lag(ts) OVER (ORDER BY ts, event_id) IS NULL
        OR ts - lag(ts) OVER (ORDER BY ts, event_id) >= INTERVAL '30 minutes' THEN 1 ELSE 0 END AS starts
    FROM log_events WHERE dataset = 'bgl' AND alert_label = 'APPREAD')
), starts AS (
  SELECT episode, min(ts) AS t0 FROM ep GROUP BY episode
), pre AS (
  SELECT s.episode, e.node, e.ts
  FROM starts s JOIN log_events e
    ON e.dataset = 'bgl' AND e.pattern_id = 'bdec89f666f62cf9'
    AND e.ts >= s.t0 - INTERVAL '10 minutes' AND e.ts < s.t0
)
SELECT s.episode, strftime(s.t0, '%Y-%m-%dT%H:%M:%SZ') AS start,
  count(p.node) AS chdir_events,
  round(epoch(s.t0 - max(p.ts)), 1) AS last_chdir_s_before,
  count(DISTINCT p.node) AS chdir_nodes,
  (SELECT count(DISTINCT node) FROM ep WHERE ep.episode = s.episode) AS appread_nodes,
  count(DISTINCT p.node) FILTER (WHERE p.node IN (SELECT node FROM ep WHERE ep.episode = s.episode)) AS shared_nodes
FROM starts s LEFT JOIN pre p USING (episode)
GROUP BY s.episode, s.t0 ORDER BY s.episode;

-- @ APPREAD: one episode start with its neighbourhood on the same node (5 before, verbatim)
WITH first_event AS (
  SELECT event_id, node, ts FROM log_events
  WHERE dataset = 'bgl' AND alert_label = 'APPREAD'
  ORDER BY ts, event_id LIMIT 1
)
SELECT e.event_id, strftime(e.ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS ts, e.level, e.component,
  coalesce(e.alert_label, '-') AS label, left(e.message, 110) AS message
FROM log_events e, first_event f
WHERE e.dataset = 'bgl' AND e.node = f.node
  AND e.ts >= f.ts - INTERVAL '10 minutes' AND e.ts <= f.ts
ORDER BY e.ts DESC, e.event_id DESC LIMIT 6;

-- @ Development question references: parity full-text matches and APPREAD breadth in June 2005
SELECT
  (SELECT count(*) FROM log_events_idx WHERE message @@ 'parity' AND dataset = 'bgl') AS bgl_parity_matches,
  (SELECT count(DISTINCT node) FROM log_events
    WHERE dataset = 'bgl' AND alert_label = 'APPREAD'
      AND ts >= '2005-06-01 00:00:00+00' AND ts < '2005-07-01 00:00:00+00') AS appread_nodes_june,
  (SELECT count(DISTINCT rack) FROM log_events
    WHERE dataset = 'bgl' AND alert_label = 'APPREAD'
      AND ts >= '2005-06-01 00:00:00+00' AND ts < '2005-07-01 00:00:00+00') AS appread_racks_june;
