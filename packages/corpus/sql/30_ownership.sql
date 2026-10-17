-- Ownership (concept § 5.3, A-03). FICTIONAL: the organisation "Serene
-- Platform" and its teams are invented for this project; the real owners of
-- BGL and OpenStack are unknown. DRAFT, finalised after profiling in U03.
--
-- Components without a row here are counted as `unowned` (component_teams in
-- 40_stats.sql); observed so far: BGL SERV_NET. Bump VERSIONS.ownership in
-- src/versions.ts with every change.
CREATE OR REPLACE TABLE ownership AS
SELECT dataset, component, team,
  'fictional (Serene Platform); draft until U03' AS note
FROM (VALUES
  ('bgl', 'KERNEL', 'Compute Platform'),
  ('openstack', 'nova-compute', 'Compute Platform'),
  ('bgl', 'APP', 'Workload Runtime'),
  ('bgl', 'MMCS', 'Control Plane'),
  ('bgl', 'BGLMASTER', 'Control Plane'),
  ('bgl', 'CMCS', 'Control Plane'),
  ('openstack', 'nova-scheduler', 'Control Plane'),
  ('bgl', 'HARDWARE', 'Hardware Operations'),
  ('bgl', 'LINKCARD', 'Hardware Operations'),
  ('bgl', 'MONITOR', 'Hardware Operations'),
  ('bgl', 'DISCOVERY', 'Hardware Operations'),
  ('openstack', 'nova-api', 'API Gateway')
) AS t(dataset, component, team)
ORDER BY dataset, component;
