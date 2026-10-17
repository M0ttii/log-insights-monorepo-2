-- Author: Codex golden_patterns (independent LOG-13 verifier).
-- Specification: concept R-01–R-10, A-10/A-11; technical § 6.1/8.2/13.
-- No tool SQL/filter compiler is used. MAX over prior rows deliberately replaces LAG.
-- Context7 /serenedb/serenedb: window framing, DISTINCT aggregates, date functions.
WITH span AS (
  SELECT min(ts) AS start, max(ts) + INTERVAL '1 microsecond' AS finish
  FROM log_events WHERE dataset = $1
), bounds AS (
  SELECT start, finish,
    coalesce($2::TIMESTAMPTZ, start) AS lo,
    coalesce($3::TIMESTAMPTZ, finish) AS hi
  FROM span
), periods AS (
  SELECT *, lo - (hi - lo) AS previous,
    lo > start AND hi > start AND lo < finish AS comparable
  FROM bounds
), history AS (
  SELECT e.*, coalesce(o.team, 'unowned') AS team,
    p.start, p.lo, p.hi, p.previous, p.comparable
  FROM log_events e CROSS JOIN periods p
  LEFT JOIN ownership o ON o.dataset = e.dataset AND o.component = e.component
  WHERE e.dataset = $1
    AND ($4::VARCHAR IS NULL OR e.node = $4)
    AND ($5::VARCHAR IS NULL OR coalesce(o.team, 'unowned') = $5)
    AND ($6::VARCHAR IS NULL OR e.pattern_id = $6)
    AND (NOT $7::BOOLEAN OR e.is_error)
    AND (NOT $8::BOOLEAN OR
      (e.dataset = 'bgl' AND (e.is_error OR e.is_alert)) OR
      (e.dataset = 'openstack' AND (e.is_error OR e.http_status BETWEEN 500 AND 599)))
), current_events AS (
  SELECT *, max(ts) OVER (
    PARTITION BY pattern_id ORDER BY ts, event_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
  ) AS preceding_time
  FROM history WHERE ts >= lo AND ts < hi
), current_groups AS (
  SELECT pattern_id, count(*) AS events,
    min(ts) AS first_ts, max(ts) AS last_ts,
    first(event_id ORDER BY ts, event_id) AS example_event_id,
    count(*) FILTER (WHERE preceding_time IS NULL OR
      ts >= preceding_time + INTERVAL '30 minutes') AS episodes,
    count(DISTINCT date_trunc('day', ts)) AS active_days,
    count(DISTINCT date_trunc('week', ts)) AS active_weeks,
    CASE WHEN count(node) = count(*) THEN count(DISTINCT node) END AS nodes,
    CASE WHEN count(rack) = count(*) THEN count(DISTINCT rack) END AS racks,
    CASE WHEN count(instance_id) = count(*) THEN count(DISTINCT instance_id) END AS instances,
    CASE WHEN count(request_id) = count(*) THEN count(DISTINCT request_id) END AS requests,
    count(DISTINCT component) AS components
  FROM current_events GROUP BY pattern_id
), historical_groups AS (
  SELECT pattern_id, min(pattern) AS pattern, min(component) AS component,
    min(team) AS team,
    count(*) FILTER (WHERE ts >= previous AND ts < lo) AS baseline,
    min(ts) FILTER (WHERE ts < lo) AS earlier
  FROM history GROUP BY pattern_id
), joined AS (
  SELECT h.pattern_id, h.pattern, h.component, h.team,
    coalesce(c.events, 0) AS events,
    strftime(c.first_ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS first_seen,
    strftime(c.last_ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS last_seen,
    c.example_event_id, coalesce(c.episodes, 0) AS episodes,
    coalesce(c.active_days, 0) AS active_days,
    coalesce(c.active_weeks, 0) AS active_weeks,
    CASE WHEN c.pattern_id IS NULL THEN 0 ELSE c.nodes END AS nodes,
    CASE WHEN c.pattern_id IS NULL THEN 0 ELSE c.racks END AS racks,
    CASE WHEN c.pattern_id IS NULL THEN 0 ELSE c.instances END AS instances,
    CASE WHEN c.pattern_id IS NULL THEN 0 ELSE c.requests END AS requests,
    coalesce(c.components, 0) AS components,
    CASE WHEN p.comparable THEN h.baseline END AS baseline,
    CASE WHEN p.comparable THEN coalesce(c.events, 0) - h.baseline END AS delta,
    strftime(h.earlier, '%Y-%m-%dT%H:%M:%S.%fZ') AS first_seen_before_window,
    CASE
      WHEN c.events > 0 AND p.lo > p.start AND h.earlier IS NULL THEN 'new'
      WHEN p.comparable AND h.baseline > 0 AND c.events >= 2 * h.baseline
        AND c.events - h.baseline >= 20 THEN 'escalating'
      WHEN p.comparable AND c.events > 0 AND h.baseline = 0 AND h.earlier IS NOT NULL THEN 'reappeared'
      WHEN c.events > 0 THEN 'ongoing'
      WHEN p.comparable AND h.baseline > 0 THEN 'quiet'
    END AS status,
    p.comparable
  FROM historical_groups h LEFT JOIN current_groups c USING (pattern_id)
  CROSS JOIN periods p
  WHERE c.events > 0 OR (NOT $8::BOOLEAN AND p.comparable AND h.baseline > 0)
), measurements AS (
  SELECT *, episodes >= 2 AS recurring,
    CASE WHEN $1::VARCHAR = 'bgl' THEN nodes ELSE instances END AS breadth,
    sum(events) OVER () AS total_events,
    count(*) FILTER (WHERE events > 0) OVER () AS pattern_count,
    CASE WHEN comparable THEN (SELECT count(*) FROM historical_groups h
      LEFT JOIN current_groups c USING (pattern_id)
      WHERE h.baseline > 0 AND c.pattern_id IS NULL) END AS quiet_count,
    count(*) OVER () AS qualifying,
    events::DOUBLE / nullif(sum(events) OVER (), 0) AS share_of_error_events
  FROM joined
), availability AS (
  SELECT *, count(breadth) OVER () = count(*) OVER () AS has_breadth,
    count(delta) OVER () = count(*) OVER () AS has_change
  FROM measurements
), ranked AS (
  SELECT *, row_number() OVER (ORDER BY /* GOLDEN_ORDER */) AS position
  FROM availability
), first_candidate AS (
  SELECT * FROM ranked WHERE position = 1
)
SELECT r.*,
  (SELECT count(*) FROM ranked o WHERE o.position > 1 AND NOT (
    f.episodes >= o.episodes
    AND (NOT f.has_breadth OR f.breadth >= o.breadth)
    AND (NOT f.has_change OR f.delta >= o.delta)
    AND (f.episodes > o.episodes OR (f.has_breadth AND f.breadth > o.breadth)
      OR (f.has_change AND f.delta > o.delta)))) AS not_dominated,
  max(r.episodes) OVER () AS max_episodes,
  max(r.breadth) OVER () AS max_breadth,
  max(r.delta) OVER () AS max_increase,
  max(r.events) OVER () AS max_events
FROM ranked r CROSS JOIN first_candidate f
ORDER BY r.position, r.pattern_id
