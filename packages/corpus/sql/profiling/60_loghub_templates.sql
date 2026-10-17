-- Pattern check 1 (technical.md § 7, "Musterprüfung"): our patterns against
-- the Loghub templates of the 2k samples. Run with --samples: the template
-- files are read from the raw directory mounted into SereneDB and joined to
-- the sample files' events by line number. Against the full corpus the
-- queries return no rows.
--
-- A merge is one of our patterns covering several Loghub templates; a split
-- is one Loghub template spread over several of our patterns. Every case is
-- justified or corrected in sql/20_patterns.sql; the integration test
-- tests/integration/patterns.test.ts pins the reviewed list.

-- @ Patterns and templates per dataset
WITH templates AS (
  SELECT 'bgl' AS dataset, "LineId" AS line_no, "EventId" AS event_template_id,
    "EventTemplate" AS template
  FROM read_csv('/data/raw/loghub-2k/BGL_2k.log_structured.csv', header = true, all_varchar = true)
  UNION ALL
  SELECT 'openstack', "LineId", "EventId", "EventTemplate"
  FROM read_csv('/data/raw/loghub-2k/OpenStack_2k.log_structured.csv', header = true, all_varchar = true)
), joined AS (
  SELECT e.dataset, e.pattern_id, t.event_template_id
  FROM log_events e
  JOIN templates t ON t.dataset = e.dataset AND t.line_no::BIGINT = e.line_no
    AND e.source_file IN ('BGL_2k.log', 'OpenStack_2k.log')
)
SELECT dataset, count(*) AS events,
  count(DISTINCT pattern_id) AS patterns,
  count(DISTINCT event_template_id) AS templates
FROM joined GROUP BY dataset ORDER BY dataset;

-- @ Merges: one pattern, several templates
WITH templates AS (
  SELECT 'bgl' AS dataset, "LineId" AS line_no, "EventId" AS event_template_id,
    "EventTemplate" AS template
  FROM read_csv('/data/raw/loghub-2k/BGL_2k.log_structured.csv', header = true, all_varchar = true)
  UNION ALL
  SELECT 'openstack', "LineId", "EventId", "EventTemplate"
  FROM read_csv('/data/raw/loghub-2k/OpenStack_2k.log_structured.csv', header = true, all_varchar = true)
), joined AS (
  SELECT e.dataset, e.component, e.pattern_id, e.pattern, t.event_template_id, t.template
  FROM log_events e
  JOIN templates t ON t.dataset = e.dataset AND t.line_no::BIGINT = e.line_no
    AND e.source_file IN ('BGL_2k.log', 'OpenStack_2k.log')
)
SELECT dataset, pattern_id, any_value(component) AS component,
  any_value(pattern) AS pattern, count(*) AS events,
  string_agg(DISTINCT event_template_id || ' ' || template, ' | '
    ORDER BY event_template_id || ' ' || template) AS templates
FROM joined
GROUP BY dataset, pattern_id
HAVING count(DISTINCT event_template_id) > 1
ORDER BY dataset, pattern_id;

-- @ Splits: one template, several patterns
WITH templates AS (
  SELECT 'bgl' AS dataset, "LineId" AS line_no, "EventId" AS event_template_id,
    "EventTemplate" AS template
  FROM read_csv('/data/raw/loghub-2k/BGL_2k.log_structured.csv', header = true, all_varchar = true)
  UNION ALL
  SELECT 'openstack', "LineId", "EventId", "EventTemplate"
  FROM read_csv('/data/raw/loghub-2k/OpenStack_2k.log_structured.csv', header = true, all_varchar = true)
), joined AS (
  SELECT e.dataset, e.component, e.pattern_id, e.pattern, t.event_template_id, t.template
  FROM log_events e
  JOIN templates t ON t.dataset = e.dataset AND t.line_no::BIGINT = e.line_no
    AND e.source_file IN ('BGL_2k.log', 'OpenStack_2k.log')
)
SELECT dataset, event_template_id, any_value(template) AS template,
  count(DISTINCT pattern_id) AS patterns, count(*) AS events,
  string_agg(DISTINCT component || ': ' || pattern, ' | '
    ORDER BY component || ': ' || pattern) AS our_patterns
FROM joined
GROUP BY dataset, event_template_id
HAVING count(DISTINCT pattern_id) > 1
ORDER BY dataset, event_template_id;
