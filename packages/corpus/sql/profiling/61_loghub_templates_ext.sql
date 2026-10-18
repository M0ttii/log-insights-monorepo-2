-- Pattern check 1 for the extension datasets (U26, technical.md § 7.1):
-- like 60_loghub_templates.sql, against the Loghub templates of the HDFS,
-- OpenSSH, Apache, Linux and ZooKeeper 2k samples. Run against the database
-- of `pnpm data:setup --samples --with all` (log_insights_samples_ext); the
-- integration test tests/integration/patterns-extensions.test.ts pins the
-- reviewed result. Against other databases the queries return no rows.

-- @ Patterns and templates per extension dataset
WITH templates AS (
  SELECT 'hdfs' AS dataset, "LineId" AS line_no, "EventId" AS event_template_id,
    "EventTemplate" AS template
  FROM read_csv('/data/raw/loghub-2k/HDFS_2k.log_structured.csv', header = true, all_varchar = true)
  UNION ALL
  SELECT 'openssh', "LineId", "EventId", "EventTemplate"
  FROM read_csv('/data/raw/loghub-2k/OpenSSH_2k.log_structured.csv', header = true, all_varchar = true)
  UNION ALL
  SELECT 'apache', "LineId", "EventId", "EventTemplate"
  FROM read_csv('/data/raw/loghub-2k/Apache_2k.log_structured.csv', header = true, all_varchar = true)
  UNION ALL
  SELECT 'linux', "LineId", "EventId", "EventTemplate"
  FROM read_csv('/data/raw/loghub-2k/Linux_2k.log_structured.csv', header = true, all_varchar = true)
  UNION ALL
  SELECT 'zookeeper', "LineId", "EventId", "EventTemplate"
  FROM read_csv('/data/raw/loghub-2k/Zookeeper_2k.log_structured.csv', header = true, all_varchar = true)
), joined AS (
  SELECT e.dataset, e.component, e.pattern_id, e.pattern, t.event_template_id, t.template
  FROM log_events e
  JOIN templates t ON t.dataset = e.dataset AND t.line_no::BIGINT = e.line_no
    AND e.source_file IN ('HDFS_2k.log', 'OpenSSH_2k.log', 'Apache_2k.log', 'Linux_2k.log', 'Zookeeper_2k.log')
)
SELECT dataset, count(*) AS events,
  count(DISTINCT pattern_id) AS patterns,
  count(DISTINCT event_template_id) AS templates
FROM joined GROUP BY dataset ORDER BY dataset;

-- @ Merges: one pattern, several templates
WITH templates AS (
  SELECT 'hdfs' AS dataset, "LineId" AS line_no, "EventId" AS event_template_id,
    "EventTemplate" AS template
  FROM read_csv('/data/raw/loghub-2k/HDFS_2k.log_structured.csv', header = true, all_varchar = true)
  UNION ALL
  SELECT 'openssh', "LineId", "EventId", "EventTemplate"
  FROM read_csv('/data/raw/loghub-2k/OpenSSH_2k.log_structured.csv', header = true, all_varchar = true)
  UNION ALL
  SELECT 'apache', "LineId", "EventId", "EventTemplate"
  FROM read_csv('/data/raw/loghub-2k/Apache_2k.log_structured.csv', header = true, all_varchar = true)
  UNION ALL
  SELECT 'linux', "LineId", "EventId", "EventTemplate"
  FROM read_csv('/data/raw/loghub-2k/Linux_2k.log_structured.csv', header = true, all_varchar = true)
  UNION ALL
  SELECT 'zookeeper', "LineId", "EventId", "EventTemplate"
  FROM read_csv('/data/raw/loghub-2k/Zookeeper_2k.log_structured.csv', header = true, all_varchar = true)
), joined AS (
  SELECT e.dataset, e.component, e.pattern_id, e.pattern, t.event_template_id, t.template
  FROM log_events e
  JOIN templates t ON t.dataset = e.dataset AND t.line_no::BIGINT = e.line_no
    AND e.source_file IN ('HDFS_2k.log', 'OpenSSH_2k.log', 'Apache_2k.log', 'Linux_2k.log', 'Zookeeper_2k.log')
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
  SELECT 'hdfs' AS dataset, "LineId" AS line_no, "EventId" AS event_template_id,
    "EventTemplate" AS template
  FROM read_csv('/data/raw/loghub-2k/HDFS_2k.log_structured.csv', header = true, all_varchar = true)
  UNION ALL
  SELECT 'openssh', "LineId", "EventId", "EventTemplate"
  FROM read_csv('/data/raw/loghub-2k/OpenSSH_2k.log_structured.csv', header = true, all_varchar = true)
  UNION ALL
  SELECT 'apache', "LineId", "EventId", "EventTemplate"
  FROM read_csv('/data/raw/loghub-2k/Apache_2k.log_structured.csv', header = true, all_varchar = true)
  UNION ALL
  SELECT 'linux', "LineId", "EventId", "EventTemplate"
  FROM read_csv('/data/raw/loghub-2k/Linux_2k.log_structured.csv', header = true, all_varchar = true)
  UNION ALL
  SELECT 'zookeeper', "LineId", "EventId", "EventTemplate"
  FROM read_csv('/data/raw/loghub-2k/Zookeeper_2k.log_structured.csv', header = true, all_varchar = true)
), joined AS (
  SELECT e.dataset, e.component, e.pattern_id, e.pattern, t.event_template_id, t.template
  FROM log_events e
  JOIN templates t ON t.dataset = e.dataset AND t.line_no::BIGINT = e.line_no
    AND e.source_file IN ('HDFS_2k.log', 'OpenSSH_2k.log', 'Apache_2k.log', 'Linux_2k.log', 'Zookeeper_2k.log')
)
SELECT dataset, event_template_id, any_value(template) AS template,
  count(DISTINCT pattern_id) AS patterns, count(*) AS events,
  string_agg(DISTINCT component || ': ' || pattern, ' | '
    ORDER BY component || ': ' || pattern) AS our_patterns
FROM joined
GROUP BY dataset, event_template_id
HAVING count(DISTINCT pattern_id) > 1
ORDER BY dataset, event_template_id;
