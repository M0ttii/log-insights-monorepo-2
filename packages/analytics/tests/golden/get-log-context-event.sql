-- Author: Codex golden_context (independent LOG-13 verifier).
-- A-06: lexicographic timestamp/event_id order, nearest 0..25 on each side.
-- Context7 /serenedb/serenedb timestamp docs: interval arithmetic and epoch_us.
-- Params: event_id, scope, minutes, before limit, after limit.
WITH anchor AS (SELECT * FROM log_events WHERE event_id = $1::BIGINT),
nearby AS (
  SELECT e.event_id::INTEGER AS event_id,
         strftime(e.ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS ts,
         (epoch_us(e.ts) - epoch_us(a.ts))::DOUBLE / 1000 AS offset_ms,
         CASE WHEN e.ts < a.ts OR (e.ts = a.ts AND e.event_id < a.event_id)
              THEN 'before' ELSE 'after' END AS direction
  FROM log_events e JOIN anchor a ON e.dataset = a.dataset
  WHERE e.event_id <> a.event_id
    AND e.ts BETWEEN a.ts - $3::INTEGER * INTERVAL '1 minute'
                 AND a.ts + $3::INTEGER * INTERVAL '1 minute'
    AND ($2 = 'dataset' OR ($2 = 'same_node' AND e.node = a.node)
      OR ($2 = 'same_component' AND e.component IS NOT DISTINCT FROM a.component)
      OR ($2 = 'same_request' AND e.request_id = a.request_id))
), ranked AS (
  SELECT *, count(*) OVER (PARTITION BY direction)::INTEGER AS in_window,
    row_number() OVER (PARTITION BY direction
      ORDER BY abs(offset_ms), CASE WHEN direction = 'before' THEN -event_id ELSE event_id END) AS nearest
  FROM nearby
), directions AS (
  SELECT 'before' AS direction, $4::INTEGER AS requested
  UNION ALL SELECT 'after' AS direction, $5::INTEGER AS requested
), counts AS (SELECT direction, max(in_window) AS in_window FROM ranked GROUP BY direction)
SELECT d.direction, d.requested, coalesce(c.in_window, 0)::INTEGER AS in_window,
       r.event_id, r.ts, r.offset_ms
FROM directions d LEFT JOIN counts c ON c.direction = d.direction
LEFT JOIN ranked r ON r.direction = d.direction AND r.nearest <= d.requested
ORDER BY d.direction DESC, r.ts, r.event_id
