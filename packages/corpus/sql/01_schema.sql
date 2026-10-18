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

-- The otel reference window (LOG-35) is rebuilt by every load that names
-- it and removed by every other load, so no stale remote snapshot survives
-- a reload: index first (it blocks the log_text dictionary in 50_index.sql),
-- then its view and tables.
DROP INDEX IF EXISTS otel_ref_idx;
DROP VIEW IF EXISTS otel_ref;
DROP TABLE IF EXISTS otel_reference;
DROP TABLE IF EXISTS otel_sources;
DROP TABLE IF EXISTS otel_row_groups;
-- The OTLP replay (LOG-35): index and view over the listener table, and the
-- replay facts. The listener's own rows stay; a replay load clears its
-- previous rows itself (src/replay.ts).
DROP INDEX IF EXISTS otel_replay_idx;
DROP VIEW IF EXISTS otel_replay_events;
DROP TABLE IF EXISTS otel_replay;
