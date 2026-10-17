-- Gate objects live in their own schema so the probes never touch tables of
-- the loader (U02). Re-running the gate starts from an empty schema.
DROP SCHEMA IF EXISTS gate CASCADE;
CREATE SCHEMA gate;
