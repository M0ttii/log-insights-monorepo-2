-- Corpus description and views. corpus_stats is the source for
-- describe_corpus (A-04): no figure about the corpus is a constant in code.
-- The views are recreated on every load: 01_schema.sql drops them, because
-- replacing log_events or ownership fails while a view depends on them
-- (gate G3).

-- R-01: API accesses are OpenStack lines with an HTTP status, with or without
-- request ID. Requests are count(DISTINCT request_id) over this view.
CREATE OR REPLACE VIEW api_access AS
SELECT * FROM log_events
WHERE dataset = 'openstack' AND http_status IS NOT NULL;

-- Every observed component with its fictional team, or `unowned` (A-03).
CREATE OR REPLACE VIEW component_teams AS
SELECT c.dataset, c.component, coalesce(o.team, 'unowned') AS team,
  o.team IS NULL AS is_unowned, c.events
FROM (
  SELECT dataset, component, count(*) AS events
  FROM log_events GROUP BY dataset, component
) c
LEFT JOIN ownership o
  ON o.dataset = c.dataset AND o.component IS NOT DISTINCT FROM c.component;

-- One row per dataset. Lists are JSON arrays ordered by events descending,
-- then name, so the table is reproducible. Labels are dataset labels, not
-- findings of this system: BGL alert categories (`null` = no alert) and the
-- OpenStack anomaly flag by instance ID (`null` = line names no instance or
-- the source has no labels).
CREATE OR REPLACE TABLE corpus_stats AS
WITH base AS (
  SELECT dataset, count(*) AS events, min(ts) AS first_ts, max(ts) AS last_ts,
    -- NULL when the dataset has no error definition (is_error unknown, R-02).
    CASE WHEN count(is_error) > 0 THEN count(*) FILTER (WHERE is_error) END AS error_events,
    count(DISTINCT pattern_id) AS patterns
  FROM log_events GROUP BY dataset
), report AS (
  SELECT dataset, sum(lines_read)::BIGINT AS lines_read,
    sum(rejected)::BIGINT AS rejected
  FROM load_report GROUP BY dataset
), levels AS (
  SELECT dataset, to_json(list({'level': level, 'events': n} ORDER BY n DESC, level)) AS levels
  FROM (SELECT dataset, level, count(*) AS n FROM log_events GROUP BY dataset, level)
  GROUP BY dataset
), components AS (
  SELECT dataset,
    to_json(list({'component': component, 'team': team, 'events': events}
      ORDER BY events DESC, component)) AS components
  FROM component_teams GROUP BY dataset
), labels AS (
  SELECT dataset, to_json(list({'label': label, 'events': n} ORDER BY n DESC, label)) AS labels
  FROM (
    SELECT dataset,
      CASE dataset
        WHEN 'bgl' THEN alert_label
        ELSE CASE is_anomalous WHEN true THEN 'anomalous' WHEN false THEN 'not_anomalous' END
      END AS label,
      count(*) AS n
    FROM log_events GROUP BY ALL
  ) GROUP BY dataset
), single AS (
  SELECT dataset, count(*) AS single_event_patterns FROM (
    SELECT dataset, pattern_id FROM log_events
    GROUP BY dataset, pattern_id HAVING count(*) = 1
  ) GROUP BY dataset
), api AS (
  SELECT 'openstack' AS dataset, count(*) AS api_accesses,
    count(*) FILTER (WHERE request_id IS NULL) AS api_accesses_without_request_id,
    count(DISTINCT request_id) AS requests
  FROM api_access
)
SELECT
  b.dataset,
  r.lines_read,
  b.events,
  r.rejected,
  b.first_ts,
  b.last_ts,
  b.error_events,
  b.patterns,
  coalesce(s.single_event_patterns, 0) AS single_event_patterns,
  -- From the dataset catalog (src/plan.ts); the base corpus texts are those of
  -- U02.
  {{TIME_BASIS}} AS time_basis,
  {{LABEL_SOURCE}} AS label_source,
  l.levels,
  c.components,
  lb.labels,
  a.api_accesses,
  a.api_accesses_without_request_id,
  a.requests
FROM base b
JOIN report r USING (dataset)
JOIN levels l USING (dataset)
JOIN components c USING (dataset)
JOIN labels lb USING (dataset)
LEFT JOIN single s USING (dataset)
LEFT JOIN api a USING (dataset)
ORDER BY b.dataset;

-- Field guide of describe_corpus (U26, A-39): per dataset and catalog
-- column the events with a value, the distinct values and the three most
-- frequent values (ties by value), computed here once per load.
-- The placeholder below holds one SELECT per dataset and column (src/plan.ts).
CREATE OR REPLACE TABLE corpus_field_stats AS
{{FIELD_STATS}}
ORDER BY dataset, field;
