-- Levels and the error definition (concept R-02, O-07). Expected values are
-- not assumed: the brief names five BGL severities, R-02 lists four error
-- level names; this file shows what the corpus contains.

-- @ Levels per dataset with is_error as loaded
SELECT dataset, coalesce(level, 'NULL') AS level, count(*) AS events,
  bool_or(is_error) AS is_error,
  round(100.0 * count(*) / sum(count(*)) OVER (PARTITION BY dataset), 3) AS pct
FROM log_events
GROUP BY dataset, level
ORDER BY dataset, events DESC, level;

-- @ BGL levels per component
SELECT component, level, count(*) AS events
FROM log_events WHERE dataset = 'bgl'
GROUP BY component, level
ORDER BY component, events DESC, level;

-- @ BGL levels vs. alert label (dataset label; - = no alert)
-- Shows whether the error levels and the dataset's alerts coincide.
SELECT level, count(*) AS events,
  count(*) FILTER (WHERE is_alert) AS alerts,
  count(*) FILTER (WHERE NOT is_alert) AS not_alerts
FROM log_events WHERE dataset = 'bgl'
GROUP BY level
ORDER BY events DESC, level;

-- @ BGL alert categories with their levels
SELECT alert_label, string_agg(DISTINCT level, ', ' ORDER BY level) AS levels,
  count(*) AS events
FROM log_events WHERE dataset = 'bgl' AND is_alert
GROUP BY alert_label
ORDER BY events DESC, alert_label;

-- @ OpenStack levels per component
SELECT component, level, count(*) AS events
FROM log_events WHERE dataset = 'openstack'
GROUP BY component, level
ORDER BY component, events DESC, level;

-- @ OpenStack ERROR lines: patterns
SELECT component, pattern, count(*) AS events
FROM log_events WHERE dataset = 'openstack' AND level IN ('ERROR', 'CRITICAL')
GROUP BY component, pattern
ORDER BY events DESC, component, pattern
LIMIT 20;
