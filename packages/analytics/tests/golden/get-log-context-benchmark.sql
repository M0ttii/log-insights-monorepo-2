-- Author: Codex golden_context (independent LOG-13 verifier).
-- Independent R-05 summary for T-12's high-volume performance fixtures.
-- MAX over the strictly preceding frame avoids the tool's lag formulation;
-- the anti-self-join oracle tests every returned pattern on smaller anchors.
-- Context7 /serenedb/serenedb documents window aggregates and timestamp intervals.
WITH matches AS (
  SELECT ts, event_id, pattern_id,
    max(ts) OVER (ORDER BY ts, event_id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_ts
  FROM log_events WHERE dataset = 'bgl'
    AND ($1::VARCHAR IS NULL OR pattern_id = $1)
    AND ($2::VARCHAR IS NULL OR regexp_matches(message, $2, 'i'))
)
SELECT count(*)::INTEGER AS matched_events,
  count(*) FILTER (WHERE previous_ts IS NULL OR ts >= previous_ts + INTERVAL '30 minutes')::INTEGER AS anchors,
  count(DISTINCT pattern_id)::INTEGER AS excluded_patterns
FROM matches
