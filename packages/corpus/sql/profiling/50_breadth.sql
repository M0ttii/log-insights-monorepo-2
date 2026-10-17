-- Breadth level (concept R-08, A-10). Coverage is the share of candidate
-- events (BGL is_error or is_alert; OpenStack is_error or 5xx) with the field
-- set. A level that is missing for some candidates cannot rank all of them.

-- @ BGL: coverage of node, midplane and rack over all events and candidates
SELECT scope, count(*) AS events,
  count(node) AS with_node, round(100.0 * count(node) / count(*), 3) AS pct_node,
  count(midplane) AS with_midplane, round(100.0 * count(midplane) / count(*), 3) AS pct_midplane,
  count(rack) AS with_rack, round(100.0 * count(rack) / count(*), 3) AS pct_rack,
  count(DISTINCT node) AS nodes, count(DISTINCT midplane) AS midplanes, count(DISTINCT rack) AS racks
FROM (
  SELECT 'all' AS scope, node, midplane, rack FROM log_events WHERE dataset = 'bgl'
  UNION ALL
  SELECT 'candidates', node, midplane, rack FROM log_events
  WHERE dataset = 'bgl' AND (is_error OR is_alert)
)
GROUP BY scope ORDER BY scope;

-- @ BGL: node value forms (prefix shape) among candidates
SELECT CASE
    WHEN node IS NULL THEN 'NULL'
    WHEN node = 'UNKNOWN_LOCATION' THEN 'UNKNOWN_LOCATION'
    ELSE regexp_replace(node, '[0-9]', '9', 'g')
  END AS node_shape,
  count(*) AS events, count(DISTINCT node) AS nodes
FROM log_events WHERE dataset = 'bgl' AND (is_error OR is_alert)
GROUP BY ALL ORDER BY events DESC, node_shape LIMIT 25;

-- @ BGL: candidate components without node or rack
-- patterns_with_no_node_event counts patterns with at least one event
-- without a node (17 in total): their breadth is not determinable (R-08).
-- The next query counts patterns with no node on any event, a subset.
SELECT component, count(*) AS events,
  count(*) FILTER (WHERE node IS NULL) AS no_node,
  count(*) FILTER (WHERE rack IS NULL) AS no_rack,
  count(DISTINCT pattern_id) AS patterns,
  count(DISTINCT pattern_id) FILTER (WHERE node IS NULL) AS patterns_with_no_node_event
FROM log_events WHERE dataset = 'bgl' AND (is_error OR is_alert)
GROUP BY component ORDER BY events DESC, component;

-- @ BGL: candidate patterns whose events never carry a node or rack
SELECT count(*) AS candidate_patterns,
  count(*) FILTER (WHERE nodes = 0) AS no_node_at_all,
  count(*) FILTER (WHERE racks = 0) AS no_rack_at_all
FROM (
  SELECT pattern_id, count(DISTINCT node) AS nodes, count(DISTINCT rack) AS racks
  FROM log_events WHERE dataset = 'bgl' AND (is_error OR is_alert)
  GROUP BY pattern_id
);

-- @ BGL: top 15 candidate patterns, breadth at node, midplane and rack level
SELECT pattern_id, component, left(any_value(pattern), 60) AS pattern, count(*) AS events,
  count(DISTINCT node) AS nodes, count(DISTINCT midplane) AS midplanes,
  count(DISTINCT rack) AS racks
FROM log_events WHERE dataset = 'bgl' AND (is_error OR is_alert)
GROUP BY pattern_id, component
ORDER BY events DESC, pattern_id LIMIT 15;

-- @ OpenStack: coverage of instance_id and request_id over all events and candidates
SELECT scope, count(*) AS events,
  count(instance_id) AS with_instance, round(100.0 * count(instance_id) / count(*), 2) AS pct_instance,
  count(request_id) AS with_request, round(100.0 * count(request_id) / count(*), 2) AS pct_request,
  count(DISTINCT instance_id) AS instances, count(DISTINCT request_id) AS requests
FROM (
  SELECT 'all' AS scope, instance_id, request_id FROM log_events WHERE dataset = 'openstack'
  UNION ALL
  SELECT 'candidates', instance_id, request_id FROM log_events
  WHERE dataset = 'openstack' AND (is_error OR http_status BETWEEN 500 AND 599)
  UNION ALL
  SELECT 'warnings', instance_id, request_id FROM log_events
  WHERE dataset = 'openstack' AND level = 'WARNING'
)
GROUP BY scope ORDER BY scope;

-- @ OpenStack: candidate patterns with instances and requests
SELECT component, left(pattern, 70) AS pattern, count(*) AS events,
  count(DISTINCT instance_id) AS instances, count(DISTINCT request_id) AS requests
FROM log_events WHERE dataset = 'openstack' AND (is_error OR http_status BETWEEN 500 AND 599)
GROUP BY component, pattern
ORDER BY events DESC, component, pattern LIMIT 40;

-- @ OpenStack: WARNING patterns with instances and requests
SELECT component, left(pattern, 90) AS pattern, count(*) AS events,
  count(DISTINCT instance_id) AS instances, count(DISTINCT request_id) AS requests
FROM log_events WHERE dataset = 'openstack' AND level = 'WARNING'
GROUP BY component, pattern
ORDER BY events DESC, component, pattern LIMIT 20;
