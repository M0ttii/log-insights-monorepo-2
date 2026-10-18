-- Load manifest (technical.md § 6.1), written only after 90_checks.sql passed.
-- One parameterised statement; src/load.ts binds the values. data_version is
-- a hash over everything except created_at (src/manifest.ts), so a second
-- load of the same files with the same rules yields the same version.
-- image is the reference Compose started (tag, plus @sha256: registry digest
-- when pinned); image_id is the Docker image ID (config digest) that
-- src/image.ts validated; server_version is SELECT version().
CREATE OR REPLACE TABLE load_manifest AS
SELECT
  $1::VARCHAR AS data_version,
  $2::TIMESTAMPTZ AS created_at,
  $3::VARCHAR AS source,
  $4::JSON AS files,
  $5::VARCHAR AS image,
  $6::VARCHAR AS image_id,
  $7::VARCHAR AS server_version,
  $8::VARCHAR AS loader_version,
  $9::VARCHAR AS parser_version,
  $10::VARCHAR AS pattern_rules_version,
  $11::VARCHAR AS ownership_version,
  $12::VARCHAR AS rules_version,
  $13::VARCHAR AS sql_digest,
  -- Loaded datasets in catalog order (U26), e.g. ["bgl","openstack"].
  $14::JSON AS datasets,
  -- Remote sources (LOG-35): per file the load-time pin, the mapping
  -- version, the reference window with its index, build time and duration;
  -- NULL without a remote dataset. Everything except the build facts is
  -- part of data_version.
  $15::JSON AS external_sources;
