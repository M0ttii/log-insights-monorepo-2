-- Load manifest (technical.md § 6.1), written only after 90_checks.sql passed.
-- One parameterised statement; src/load.ts binds the values. data_version is
-- a hash over everything except created_at (src/manifest.ts), so a second
-- load of the same files with the same rules yields the same version.
CREATE OR REPLACE TABLE load_manifest AS
SELECT
  $1::VARCHAR AS data_version,
  $2::TIMESTAMPTZ AS created_at,
  $3::VARCHAR AS source,
  $4::JSON AS files,
  $5::VARCHAR AS image,
  $6::VARCHAR AS loader_version,
  $7::VARCHAR AS parser_version,
  $8::VARCHAR AS pattern_rules_version,
  $9::VARCHAR AS ownership_version,
  $10::VARCHAR AS rules_version,
  $11::VARCHAR AS sql_digest;
