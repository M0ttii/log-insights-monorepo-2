-- Start of a load run (technical.md § 7). Executed statement by statement by
-- src/load.ts; placeholders (double braces) are filled before execution.
--
-- The manifest goes first: until this run has passed 90_checks.sql there is
-- no valid data version, and tools must notice a missing manifest instead of
-- citing the version of a previous load. 95_manifest.sql writes it again.
DROP TABLE IF EXISTS load_manifest;
