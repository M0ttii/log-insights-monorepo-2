-- Start of a load run (technical.md § 7). Executed statement by statement by
-- src/load.ts; placeholders (double braces) are filled before execution.
--
-- The manifest goes first: until this run has passed 90_checks.sql there is
-- no valid data version, and tools must notice a missing manifest instead of
-- citing the version of a previous load. 95_manifest.sql writes it again.
DROP TABLE IF EXISTS load_manifest;

-- Views over log_events and ownership (40_stats.sql) go next. SereneDB
-- 26.10.1 refuses CREATE OR REPLACE TABLE on a table a view depends on
-- (SQLSTATE 2BP01, gate G3); 26.09.1.3 dropped such views silently. Dropping
-- them here keeps a reload idempotent; 40_stats.sql recreates them.
DROP VIEW IF EXISTS api_access;
DROP VIEW IF EXISTS component_teams;
