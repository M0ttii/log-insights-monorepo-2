-- OpenStack anomaly labels (concept O-04) and components/ownership (A-03,
-- concept 5.3). Labels belong to the dataset, not to this system.

-- @ is_anomalous coverage per source file
SELECT source_file,
  count(*) AS events,
  count(*) FILTER (WHERE is_anomalous) AS anomalous,
  count(*) FILTER (WHERE NOT is_anomalous) AS not_anomalous,
  count(*) FILTER (WHERE is_anomalous IS NULL) AS no_instance,
  count(DISTINCT instance_id) AS instances
FROM log_events WHERE dataset = 'openstack'
GROUP BY source_file
ORDER BY source_file;

-- @ Labelled instances: lines, span, levels, components
SELECT instance_id, count(*) AS events,
  strftime(min(ts), '%Y-%m-%dT%H:%M:%S.%fZ') AS first_ts,
  strftime(max(ts), '%Y-%m-%dT%H:%M:%S.%fZ') AS last_ts,
  string_agg(DISTINCT level, ', ' ORDER BY level) AS levels,
  string_agg(DISTINCT component, ', ' ORDER BY component) AS components
FROM log_events WHERE is_anomalous
GROUP BY instance_id
ORDER BY instance_id;

-- @ Patterns of the labelled lines
SELECT pattern, level, count(*) AS events
FROM log_events WHERE is_anomalous
GROUP BY pattern, level
ORDER BY events DESC, pattern, level;

-- @ Instances in abnormal.log that are not labelled: lines per instance
SELECT count(DISTINCT instance_id) AS instances, count(*) AS events
FROM log_events
WHERE source_file = 'openstack_abnormal.log' AND is_anomalous = false;

-- @ Observed components per dataset with fictional team (draft)
SELECT dataset, coalesce(component, 'NULL') AS component, team, events,
  round(100.0 * events / sum(events) OVER (PARTITION BY dataset), 4) AS pct
FROM component_teams
ORDER BY dataset, events DESC, component;

-- @ BGL components: source types, levels and error/alert counts
SELECT component,
  string_agg(DISTINCT coalesce(source_type, 'NULL'), ', ' ORDER BY coalesce(source_type, 'NULL')) AS source_types,
  count(*) AS events,
  count(*) FILTER (WHERE is_error) AS error_events,
  count(*) FILTER (WHERE is_alert) AS alerts,
  count(DISTINCT pattern_id) AS patterns
FROM log_events WHERE dataset = 'bgl'
GROUP BY component
ORDER BY events DESC, component;

-- @ BGL SERV_NET and other small components verbatim
SELECT component, event_id, level, coalesce(node, 'NULL') AS node, message
FROM log_events
WHERE dataset = 'bgl' AND component IN (
  SELECT component FROM log_events WHERE dataset = 'bgl'
  GROUP BY component HAVING count(*) < 20)
ORDER BY component, event_id;

-- @ OpenStack components: loggers, levels and error counts
SELECT component, source_type, count(*) AS events,
  count(*) FILTER (WHERE level = 'WARNING') AS warnings,
  count(*) FILTER (WHERE is_error) AS error_events
FROM log_events WHERE dataset = 'openstack'
GROUP BY component, source_type
ORDER BY component, events DESC, source_type;
