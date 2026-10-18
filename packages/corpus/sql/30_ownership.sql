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
-- Extensions (U26, ownership 1.1.0; concept 5.3): the same organisation
-- gets Storage Platform (HDFS datanode classes), Access Services (sshd and
-- the login and remote-access programs of Linux), Web Platform (httpd) and
-- Coordination Services (every ZooKeeper class, by rule below). Deliberately
-- unowned, so the unowned path stays visible: the rarer Linux programs
-- (named, cups, smartd, ntpd, logrotate, syslog, …) and Linux lines without
-- a program; load_checks lists them with their event counts.
--
-- Only rows of the loaded datasets are kept (placeholder below), so a base-corpus
-- load has exactly the rows of ownership 1.0.0.
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
    'compute and metadata API, token validation'),
  ('hdfs', 'dfs.DataNode', 'Storage Platform',
    'HDFS datanode: block storage and replication'),
  ('hdfs', 'dfs.DataNode$BlockReceiver', 'Storage Platform',
    'HDFS datanode: receiving block data'),
  ('hdfs', 'dfs.DataNode$DataTransfer', 'Storage Platform',
    'HDFS datanode: transferring blocks to other datanodes'),
  ('hdfs', 'dfs.DataNode$DataXceiver', 'Storage Platform',
    'HDFS datanode: serving and receiving block streams'),
  ('hdfs', 'dfs.DataNode$PacketResponder', 'Storage Platform',
    'HDFS datanode: acknowledging written packets'),
  ('hdfs', 'dfs.FSDataset', 'Storage Platform',
    'HDFS datanode: block files on local disks'),
  ('hdfs', 'dfs.DataBlockScanner', 'Storage Platform',
    'HDFS datanode: block verification'),
  ('hdfs', 'dfs.FSNamesystem', 'Control Plane',
    'HDFS namenode: namespace, block allocation and block map'),
  ('hdfs', 'dfs.PendingReplicationBlocks$PendingReplicationMonitor', 'Control Plane',
    'HDFS namenode: pending replication timeouts'),
  ('openssh', 'sshd', 'Access Services',
    'OpenSSH server: remote logins and authentication'),
  ('apache', 'httpd', 'Web Platform',
    'Apache HTTP server error log'),
  ('linux', 'kernel', 'Compute Platform',
    'Linux kernel of the server'),
  ('linux', 'udev', 'Compute Platform',
    'device manager of the kernel'),
  ('linux', 'sshd(pam_unix)', 'Access Services',
    'PAM authentication of sshd logins'),
  ('linux', 'sshd', 'Access Services',
    'OpenSSH server'),
  ('linux', 'su(pam_unix)', 'Access Services',
    'PAM authentication of su'),
  ('linux', 'login(pam_unix)', 'Access Services',
    'PAM authentication of console logins'),
  ('linux', 'login', 'Access Services',
    'console logins'),
  ('linux', 'ftpd', 'Access Services',
    'FTP server connections'),
  ('linux', 'telnetd', 'Access Services',
    'telnet server connections'),
  ('linux', 'klogind', 'Access Services',
    'Kerberos remote login server'),
  ('linux', 'xinetd', 'Access Services',
    'super-server that starts the remote-access daemons'),
  ('linux', 'unix_chkpwd', 'Access Services',
    'PAM password check helper'),
  ('linux', 'httpd', 'Web Platform',
    'Apache HTTP server on this host')
) AS t(dataset, component, team, reason)
WHERE dataset IN ({{DATASETS}})
{{EXTENSION_OWNERSHIP}}
ORDER BY dataset, component;
