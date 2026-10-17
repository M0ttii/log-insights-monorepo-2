-- Episode threshold (concept R-05). Gaps are measured between consecutive
-- events of the same pattern over the whole dataset, ordered by ts, then
-- event_id (as in R-05). This is a profile of the unfiltered corpus only;
-- the tools compute episodes per call over the filtered scope.

-- @ Gap percentiles per dataset (seconds; all patterns, gaps > 0 and = 0 separately)
WITH gaps AS (
  SELECT dataset,
    epoch(ts - lag(ts) OVER (PARTITION BY pattern_id ORDER BY ts, event_id)) AS gap_s
  FROM log_events
)
SELECT dataset, count(gap_s) AS gaps,
  count(*) FILTER (WHERE gap_s = 0) AS zero_gaps,
  round(quantile_cont(gap_s, 0.5), 1) AS p50,
  round(quantile_cont(gap_s, 0.75), 1) AS p75,
  round(quantile_cont(gap_s, 0.9), 1) AS p90,
  round(quantile_cont(gap_s, 0.95), 1) AS p95,
  round(quantile_cont(gap_s, 0.99), 1) AS p99
FROM gaps WHERE gap_s IS NOT NULL
GROUP BY dataset ORDER BY dataset;

-- @ Gap histogram per dataset (share of gaps per band)
-- The band edges bracket the candidate thresholds 5, 10, 30, 60, 120 min.
WITH gaps AS (
  SELECT dataset,
    epoch(ts - lag(ts) OVER (PARTITION BY pattern_id ORDER BY ts, event_id)) AS gap_s
  FROM log_events
), banded AS (
  SELECT dataset,
    CASE
      WHEN gap_s < 1 THEN '1: < 1 s'
      WHEN gap_s < 60 THEN '2: 1 s – 1 min'
      WHEN gap_s < 300 THEN '3: 1 – 5 min'
      WHEN gap_s < 600 THEN '4: 5 – 10 min'
      WHEN gap_s < 1800 THEN '5: 10 – 30 min'
      WHEN gap_s < 3600 THEN '6: 30 – 60 min'
      WHEN gap_s < 7200 THEN '7: 1 – 2 h'
      WHEN gap_s < 86400 THEN '8: 2 h – 1 d'
      ELSE '9: ≥ 1 d'
    END AS band
  FROM gaps WHERE gap_s IS NOT NULL
)
SELECT dataset, band, count(*) AS gaps,
  round(100.0 * count(*) / sum(count(*)) OVER (PARTITION BY dataset), 2) AS pct,
  round(100.0 * sum(count(*)) OVER (PARTITION BY dataset ORDER BY band)
    / sum(count(*)) OVER (PARTITION BY dataset), 2) AS cum_pct
FROM banded
GROUP BY dataset, band ORDER BY dataset, band;

-- @ Gap histogram of error/alert patterns (R-08 candidates; BGL is_error or is_alert, OpenStack is_error or 5xx)
WITH gaps AS (
  SELECT dataset,
    epoch(ts - lag(ts) OVER (PARTITION BY pattern_id ORDER BY ts, event_id)) AS gap_s
  FROM log_events
  WHERE is_error OR is_alert OR http_status BETWEEN 500 AND 599
), banded AS (
  SELECT dataset,
    CASE
      WHEN gap_s < 1 THEN '1: < 1 s'
      WHEN gap_s < 60 THEN '2: 1 s – 1 min'
      WHEN gap_s < 300 THEN '3: 1 – 5 min'
      WHEN gap_s < 600 THEN '4: 5 – 10 min'
      WHEN gap_s < 1800 THEN '5: 10 – 30 min'
      WHEN gap_s < 3600 THEN '6: 30 – 60 min'
      WHEN gap_s < 7200 THEN '7: 1 – 2 h'
      WHEN gap_s < 86400 THEN '8: 2 h – 1 d'
      ELSE '9: ≥ 1 d'
    END AS band
  FROM gaps WHERE gap_s IS NOT NULL
)
SELECT dataset, band, count(*) AS gaps,
  round(100.0 * count(*) / sum(count(*)) OVER (PARTITION BY dataset), 2) AS pct,
  round(100.0 * sum(count(*)) OVER (PARTITION BY dataset ORDER BY band)
    / sum(count(*)) OVER (PARTITION BY dataset), 2) AS cum_pct
FROM banded
GROUP BY dataset, band ORDER BY dataset, band;

-- @ Error/alert patterns: episodes and recurring share per candidate threshold
-- Episodes of a pattern = 1 + gaps ≥ threshold (R-05, whole dataset span).
WITH gaps AS (
  SELECT dataset, pattern_id,
    epoch(ts - lag(ts) OVER (PARTITION BY pattern_id ORDER BY ts, event_id)) AS gap_s
  FROM log_events
  WHERE is_error OR is_alert OR http_status BETWEEN 500 AND 599
), per_pattern AS (
  SELECT dataset, pattern_id, count(*) AS events,
    1 + count(*) FILTER (WHERE gap_s >= 300) AS ep_5,
    1 + count(*) FILTER (WHERE gap_s >= 600) AS ep_10,
    1 + count(*) FILTER (WHERE gap_s >= 1800) AS ep_30,
    1 + count(*) FILTER (WHERE gap_s >= 3600) AS ep_60,
    1 + count(*) FILTER (WHERE gap_s >= 7200) AS ep_120
  FROM gaps GROUP BY dataset, pattern_id
)
SELECT dataset, count(*) AS patterns,
  count(*) FILTER (WHERE events >= 2) AS with_2_events,
  count(*) FILTER (WHERE ep_5 >= 2) AS recurring_5m,
  count(*) FILTER (WHERE ep_10 >= 2) AS recurring_10m,
  count(*) FILTER (WHERE ep_30 >= 2) AS recurring_30m,
  count(*) FILTER (WHERE ep_60 >= 2) AS recurring_60m,
  count(*) FILTER (WHERE ep_120 >= 2) AS recurring_120m,
  sum(ep_5) AS episodes_5m, sum(ep_10) AS episodes_10m, sum(ep_30) AS episodes_30m,
  sum(ep_60) AS episodes_60m, sum(ep_120) AS episodes_120m
FROM per_pattern GROUP BY dataset ORDER BY dataset;

-- @ Sensitivity: top 15 error/alert patterns by events, episodes at 10/30/60 min
WITH gaps AS (
  SELECT dataset, pattern_id, component, pattern, node, ts,
    epoch(ts - lag(ts) OVER (PARTITION BY pattern_id ORDER BY ts, event_id)) AS gap_s
  FROM log_events
  WHERE is_error OR is_alert OR http_status BETWEEN 500 AND 599
)
SELECT dataset, pattern_id, component, left(any_value(pattern), 70) AS pattern,
  count(*) AS events,
  1 + count(*) FILTER (WHERE gap_s >= 600) AS ep_10,
  1 + count(*) FILTER (WHERE gap_s >= 1800) AS ep_30,
  1 + count(*) FILTER (WHERE gap_s >= 3600) AS ep_60,
  count(DISTINCT date_trunc('day', ts)) AS active_days,
  count(DISTINCT node) AS nodes
FROM gaps
GROUP BY dataset, pattern_id, component
ORDER BY dataset, events DESC, pattern_id
LIMIT 30;

-- @ OpenStack: time structure of the three files (continuous or with breaks)
WITH gaps AS (
  SELECT source_file,
    epoch(ts - lag(ts) OVER (PARTITION BY source_file ORDER BY ts, event_id)) AS gap_s
  FROM log_events WHERE dataset = 'openstack'
)
SELECT source_file, count(*) AS events,
  round(max(gap_s), 1) AS max_gap_s,
  count(*) FILTER (WHERE gap_s >= 1800) AS gaps_ge_30m
FROM gaps GROUP BY source_file ORDER BY source_file;

-- @ OpenStack: span per file
SELECT source_file,
  strftime(min(ts), '%Y-%m-%dT%H:%M:%S.%fZ') AS first_ts,
  strftime(max(ts), '%Y-%m-%dT%H:%M:%S.%fZ') AS last_ts
FROM log_events WHERE dataset = 'openstack'
GROUP BY source_file ORDER BY source_file;
