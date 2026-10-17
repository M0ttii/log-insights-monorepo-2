-- Author: Codex golden_patterns (independent LOG-13 verifier).
-- R-09 / priorityDominanceSchema: all incomparable listed pairs, followed
-- by the first candidate's first five incomparable unlisted challengers.
-- The injected query is our independent recurring-patterns.sql oracle.
WITH golden AS (
/* GOLDEN_QUERY */
), pairs AS (
  SELECT a.pattern_id AS a, b.pattern_id AS b,
    a.position AS a_position, b.position AS b_position,
    b.position <= $9::INTEGER AS b_listed,
    CASE WHEN a.episodes > b.episodes THEN 1
         WHEN a.episodes < b.episodes THEN -1 ELSE 0 END AS episodes,
    CASE WHEN a.has_breadth AND a.breadth > b.breadth THEN 1
         WHEN a.has_breadth AND a.breadth < b.breadth THEN -1 ELSE 0 END AS breadth,
    CASE WHEN a.has_change AND a.delta > b.delta THEN 1
         WHEN a.has_change AND a.delta < b.delta THEN -1 ELSE 0 END AS change
  FROM golden a JOIN golden b ON a.position < b.position
  WHERE a.not_dominated > 0
    AND (b.position <= $9::INTEGER OR a.position = 1)
), incomparable AS (
  SELECT * FROM pairs
  WHERE NOT (episodes >= 0 AND breadth >= 0 AND change >= 0
             AND (episodes > 0 OR breadth > 0 OR change > 0))
    AND NOT (episodes <= 0 AND breadth <= 0 AND change <= 0
             AND (episodes < 0 OR breadth < 0 OR change < 0))
), selected AS (
  SELECT *, row_number() OVER (
    PARTITION BY b_listed ORDER BY a_position, b_position, a, b
  ) AS slot
  FROM incomparable
)
SELECT a, b, b_listed, episodes, breadth, change
FROM selected WHERE b_listed OR slot <= 5
ORDER BY b_listed DESC, a_position, b_position, a, b
