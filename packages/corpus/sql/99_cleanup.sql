-- Removes the staging tables of a load run. Runs after a successful run; a
-- failed run keeps them for inspection, and the next run replaces them.
DROP TABLE IF EXISTS stage_read_bgl;
DROP TABLE IF EXISTS stage_read_rejects_bgl;
DROP TABLE IF EXISTS stage_lines_bgl;
DROP TABLE IF EXISTS stage_files_bgl;
DROP TABLE IF EXISTS stage_read_openstack;
DROP TABLE IF EXISTS stage_read_rejects_openstack;
DROP TABLE IF EXISTS stage_lines_openstack;
DROP TABLE IF EXISTS stage_files_openstack;
DROP TABLE IF EXISTS stage_openstack_labels;
DROP TABLE IF EXISTS stage_bgl;
DROP TABLE IF EXISTS stage_openstack;
DROP TABLE IF EXISTS stage_rejects;
{{EXTENSION_CLEANUP}}
