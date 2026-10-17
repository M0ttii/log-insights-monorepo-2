-- Author: Codex golden_context (independent LOG-13 verifier).
-- R-05/R-11 from concept.md; no tool SQL or filter compiler was consulted.
-- Distinct timestamps + anti-self-join find episode starts without lag().
-- Context7 /serenedb/serenedb: timestamp.md (epoch_us/interval),
-- from_and_join (anti join), regular_expressions.md (RE2 regexp_matches).
-- Params: dataset, pattern_id|null, word regex|null, from|null, to|null,
-- node|null, window minutes, top_n. Filters constrain anchors only.
WITH scope AS (
  SELECT greatest(min(ts), coalesce($4::TIMESTAMPTZ, min(ts))) AS start_ts,
         least(max(ts) + INTERVAL '1 microsecond',
               coalesce($5::TIMESTAMPTZ, max(ts) + INTERVAL '1 microsecond')) AS end_ts
  FROM log_events WHERE dataset = $1
), matched AS (
  SELECT event_id, ts, pattern_id FROM log_events
  WHERE dataset = $1
    AND ($2::VARCHAR IS NULL OR pattern_id = $2)
    AND ($3::VARCHAR IS NULL OR regexp_matches(message, $3, 'i'))
    AND ($4::TIMESTAMPTZ IS NULL OR ts >= $4::TIMESTAMPTZ)
    AND ($5::TIMESTAMPTZ IS NULL OR ts < $5::TIMESTAMPTZ)
    AND ($6::VARCHAR IS NULL OR node = $6)
), times AS (
  SELECT ts, min(event_id) AS event_id FROM matched GROUP BY ts
), anchors AS (
  SELECT current_event.* FROM times current_event
  ANTI JOIN times previous_event
    ON previous_event.ts < current_event.ts
   AND previous_event.ts > current_event.ts - INTERVAL '30 minutes'
), totals AS (
  SELECT (SELECT count(*) FROM matched)::INTEGER AS matched_events,
         (SELECT count(*) FROM anchors)::INTEGER AS anchors,
         (SELECT count(DISTINCT pattern_id) FROM matched)::INTEGER AS excluded_patterns,
         strftime(start_ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS grid_from,
         strftime(end_ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS grid_to,
         ceil((epoch_us(end_ts) - epoch_us(start_ts))::DOUBLE /
              ($7::BIGINT * 60000000))::INTEGER AS grid_windows
  FROM scope
), directions AS (
  SELECT 'before' AS direction UNION ALL SELECT 'after' AS direction
), hits AS (
  SELECT d.direction, e.pattern_id,
         count(DISTINCT a.event_id)::INTEGER AS anchors_with_pattern,
         min(e.event_id)::INTEGER AS example_event_id
  FROM anchors a CROSS JOIN directions d
  JOIN log_events e ON e.dataset = $1
    AND ((d.direction = 'before' AND e.ts >= a.ts - $7::INTEGER * INTERVAL '1 minute' AND e.ts < a.ts)
      OR (d.direction = 'after' AND e.ts > a.ts AND e.ts <= a.ts + $7::INTEGER * INTERVAL '1 minute'))
  WHERE e.pattern_id NOT IN (SELECT pattern_id FROM matched)
  GROUP BY d.direction, e.pattern_id
), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY direction ORDER BY anchors_with_pattern DESC, pattern_id) AS position,
    count(*) OVER (PARTITION BY direction)::INTEGER AS patterns_found
  FROM hits
), selected AS (
  SELECT * FROM ranked WHERE position <= $8::INTEGER
), base AS (
  SELECT e.pattern_id,
         count(DISTINCT floor((epoch_us(e.ts) - epoch_us(s.start_ts))::DOUBLE /
                             ($7::BIGINT * 60000000)))::INTEGER AS base_rate_windows
  FROM log_events e CROSS JOIN scope s
  WHERE e.dataset = $1 AND e.ts >= s.start_ts AND e.ts < s.end_ts
    AND e.pattern_id IN (SELECT pattern_id FROM selected)
  GROUP BY e.pattern_id
)
SELECT t.*, d.direction, coalesce(r.patterns_found, 0)::INTEGER AS patterns_found,
       r.pattern_id, r.anchors_with_pattern, r.example_event_id,
       r.anchors_with_pattern::DOUBLE / nullif(t.anchors, 0) AS anchor_share,
       CASE WHEN t.anchors >= 5 THEN coalesce(b.base_rate_windows, 0) END AS base_rate_windows,
       CASE WHEN t.anchors >= 5 THEN coalesce(b.base_rate_windows, 0)::DOUBLE / t.grid_windows END AS base_rate,
       CASE WHEN t.anchors >= 5 THEN (r.anchors_with_pattern::DOUBLE / t.anchors) /
         nullif(coalesce(b.base_rate_windows, 0)::DOUBLE / t.grid_windows, 0) END AS ratio
FROM totals t CROSS JOIN directions d
LEFT JOIN selected r ON r.direction = d.direction
LEFT JOIN base b ON b.pattern_id = r.pattern_id
ORDER BY d.direction DESC, r.anchors_with_pattern DESC, r.pattern_id
