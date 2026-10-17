-- Pattern check 2 (technical.md § 7, "Musterprüfung"): visual review on the
-- full corpus. For the 20 most frequent and 20 randomly chosen rare patterns
-- per dataset, up to three original messages are shown, checked for wrong
-- merges (different failures in one pattern) and unnecessary splits (one
-- failure in several patterns). "Random" is deterministic: rare patterns
-- (at most 10 events) ordered by md5 of the pattern ID with a fixed salt, so
-- the review can be repeated. The three messages per pattern are its
-- distinct messages ordered the same way.

-- @ Pattern count and single-event share per dataset
SELECT dataset, count(*) AS patterns,
  count(*) FILTER (WHERE events = 1) AS single_event,
  round(100.0 * count(*) FILTER (WHERE events = 1) / count(*), 1) AS pct_single,
  count(*) FILTER (WHERE events <= 10) AS rare_le_10
FROM (SELECT dataset, pattern_id, count(*) AS events FROM log_events GROUP BY ALL)
GROUP BY dataset ORDER BY dataset;

-- @ Patterns per component
SELECT dataset, component, count(DISTINCT pattern_id) AS patterns, count(*) AS events
FROM log_events GROUP BY ALL ORDER BY dataset, patterns DESC, component;

-- @ 20 most frequent patterns per dataset with three original messages
WITH p AS (
  SELECT dataset, pattern_id, any_value(component) AS component,
    any_value(pattern) AS pattern, count(*) AS events,
    count(DISTINCT message) AS distinct_messages,
    row_number() OVER (PARTITION BY dataset ORDER BY count(*) DESC, pattern_id) AS rk
  FROM log_events GROUP BY dataset, pattern_id
), top AS (SELECT * FROM p WHERE rk <= 20), samples AS (
  SELECT DISTINCT e.dataset, e.pattern_id, e.message
  FROM log_events e JOIN top USING (dataset, pattern_id)
), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY dataset, pattern_id ORDER BY md5('u03' || message), message) AS n
  FROM samples
)
SELECT t.dataset, t.rk, t.component, t.events, t.distinct_messages, t.pattern,
  string_agg(r.message, ' ‖ ' ORDER BY r.n) AS messages
FROM top t JOIN ranked r USING (dataset, pattern_id)
WHERE r.n <= 3
GROUP BY ALL ORDER BY t.dataset, t.rk;

-- @ 20 random rare patterns (≤ 10 events) per dataset with up to three original messages
WITH p AS (
  SELECT dataset, pattern_id, any_value(component) AS component,
    any_value(pattern) AS pattern, count(*) AS events
  FROM log_events GROUP BY dataset, pattern_id HAVING count(*) <= 10
), pick AS (
  SELECT *, row_number() OVER (PARTITION BY dataset ORDER BY md5('u03' || pattern_id), pattern_id) AS rk
  FROM p
), chosen AS (SELECT * FROM pick WHERE rk <= 20), samples AS (
  SELECT DISTINCT e.dataset, e.pattern_id, e.message
  FROM log_events e JOIN chosen USING (dataset, pattern_id)
), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY dataset, pattern_id ORDER BY md5('u03' || message), message) AS n
  FROM samples
)
SELECT c.dataset, c.rk, c.component, c.events, c.pattern,
  string_agg(r.message, ' ‖ ' ORDER BY r.n) AS messages
FROM chosen c JOIN ranked r USING (dataset, pattern_id)
WHERE r.n <= 3
GROUP BY ALL ORDER BY c.dataset, c.rk;

-- @ Split candidates: patterns that differ only in digits or placeholders
-- Each family must be justified by a diagnostic code or corrected.
WITH p AS (
  SELECT dataset, component, pattern, count(*) AS events
  FROM log_events GROUP BY ALL
), f AS (
  SELECT *, regexp_replace(pattern, '<[A-Z]+>|\d+', '#', 'g') AS family FROM p
)
SELECT dataset, component, count(*) AS patterns, sum(events) AS events,
  string_agg(pattern, ' | ' ORDER BY pattern) AS members
FROM f GROUP BY dataset, component, family
HAVING count(*) > 1
ORDER BY dataset, patterns DESC, events DESC, component
LIMIT 40;
