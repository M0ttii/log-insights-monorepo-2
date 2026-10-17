-- Ownership (concept § 5.3, A-03). FICTIONAL: the organisation "Serene
-- Platform" and its teams are invented for this project; the real owners of
-- BGL and OpenStack are unknown. Final after profiling (U03, LOG-12): every
-- component observed in the corpus (sql/profiling/30_labels_components.sql)
-- either has a row here, with the reason for the assignment, or is
-- deliberately left out and therefore counted as `unowned`
-- (component_teams in 40_stats.sql):
--
--   bgl SERV_NET   3 events of service network setup; kept unowned so the
--                  unowned path is visible on real data.
--
-- `note` is the same label on every row (describe_corpus reports it once);
-- `reason` explains the row. Bump VERSIONS.ownership in src/versions.ts with
-- every change.
CREATE OR REPLACE TABLE ownership AS
SELECT dataset, component, team, 'fictional (Serene Platform)' AS note, reason
FROM (VALUES
  ('bgl', 'KERNEL', 'Compute Platform',
    'compute and I/O node kernel (RAS KERNEL): hardware interrupts, machine checks, kernel termination'),
  ('openstack', 'nova-compute', 'Compute Platform',
    'hypervisor service: instance lifecycle, image cache, power state sync'),
  ('bgl', 'APP', 'Workload Runtime',
    'job control daemon ciod on the I/O nodes: program loading and job I/O streams'),
  ('bgl', 'MMCS', 'Control Plane',
    'midplane management control system and its idoproxy'),
  ('bgl', 'BGLMASTER', 'Control Plane',
    'BGLMaster process supervisor of the service node daemons'),
  ('bgl', 'CMCS', 'Control Plane',
    'control system database and block management'),
  ('openstack', 'nova-scheduler', 'Control Plane',
    'scheduler: host selection and host state'),
  ('bgl', 'HARDWARE', 'Hardware Operations',
    'node card and link card hardware: power modules, VPD, service actions'),
  ('bgl', 'LINKCARD', 'Hardware Operations',
    'link cards of the torus and tree networks'),
  ('bgl', 'MONITOR', 'Hardware Operations',
    'environmental monitoring: temperature, power, PGOOD'),
  ('bgl', 'DISCOVERY', 'Hardware Operations',
    'hardware discovery: node card status, ecid and cable checks'),
  ('openstack', 'nova-api', 'API Gateway',
    'compute and metadata API, token validation')
) AS t(dataset, component, team, reason)
ORDER BY dataset, component;
