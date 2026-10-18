import type { Connection } from "../../src/config.ts"
import { rebuildDatabase, samplesConnection } from "./helpers.ts"

/**
 * Small synthetic databases for cases the 2k samples do not contain
 * (embedded instructions, events exactly on a window bound, timestamp ties,
 * bursts). Never the demo corpus: each lives in its own database and is
 * rebuilt by every run.
 *
 * Only the relations the tools read are created, with the columns,
 * dictionary and index options of corpus/sql (01–50); analytics cannot run
 * the corpus loader (package boundary), so this is a deliberately small,
 * hand-written copy. The samples tests cover the real loader's tables.
 */

export type FixtureRow = {
  event_id: number
  dataset: "bgl" | "openstack"
  ts: string
  level: string
  component: string
  node?: string | null
  request_id?: string | null
  /** Default: `p<event_id>`, a pattern of its own. */
  pattern_id?: string
  /** Default: the message. */
  pattern?: string
  message: string
}

const text = (value: string | null) =>
  value === null ? "NULL::VARCHAR" : `'${value.replaceAll("'", "''")}'`

function valuesRow(row: FixtureRow): string {
  const node = row.node ?? null
  const rack = node === null ? null : node.slice(0, 3)
  const midplane = node === null ? null : node.slice(0, 6)
  const sourceType =
    row.dataset === "bgl" ? "'RAS'" : "'nova.osapi_compute.wsgi.server'"
  // The five extension columns (U26) are NULL for BGL and OpenStack fixtures;
  // the tools select them from the table/index and keep only the ones the
  // row's dataset carries.
  return `(${row.event_id}::BIGINT, ${text(row.dataset)}, 'fixture.log', ${sourceType}, '${row.ts}'::TIMESTAMPTZ, ${text(row.level)}, ${text(row.component)}, ${text(node)}, ${text(rack)}, ${text(midplane)}, NULL::VARCHAR, false, ${row.level === "FATAL"}, ${text(row.request_id ?? null)}, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, ${text(row.pattern_id ?? `p${row.event_id}`)}, ${text(row.pattern ?? row.message)}, ${text(row.message)})`
}

function statements(rows: readonly FixtureRow[]): string[] {
  return [
    "DROP INDEX IF EXISTS log_events_idx",
    "DROP TEXT SEARCH DICTIONARY IF EXISTS log_text",
    `CREATE OR REPLACE TABLE log_events AS SELECT * FROM (VALUES ${rows.map(valuesRow).join(", ")}) AS t(event_id, dataset, source_file, source_type, ts, level, component, node, rack, midplane, alert_label, is_alert, is_error, request_id, instance_id, endpoint, host, process_id, client_ip, thread, block_id, pattern_id, pattern, message)`,
    "CREATE OR REPLACE TABLE ownership AS SELECT * FROM (VALUES ('bgl', 'KERNEL', 'Compute Platform', 'fictional (Serene Platform)', 'fixture'), ('bgl', 'APP', 'Workload Runtime', 'fictional (Serene Platform)', 'fixture'), ('openstack', 'nova-api', 'API Gateway', 'fictional (Serene Platform)', 'fixture')) AS t(dataset, component, team, note, reason)",
    "CREATE OR REPLACE TABLE corpus_stats AS SELECT dataset, min(ts) AS first_ts, max(ts) AS last_ts FROM log_events GROUP BY dataset",
    "CREATE OR REPLACE TABLE load_manifest AS SELECT 'dv_fixture000000000' AS data_version",
    // Same dictionary and index options as corpus/sql/50_index.sql.
    `CREATE TEXT SEARCH DICTIONARY log_text AS
      split_text_icu('en_US.UTF-8')
      | normalize_tokens('en_US.UTF-8', case := 'lower')
      WITH (frequency, position, norm)`,
    `CREATE INDEX log_events_idx ON log_events USING inverted (
      dataset, source_file, component, level, source_type, node, rack, midplane,
      alert_label, request_id, instance_id, endpoint, host, process_id,
      client_ip, thread, block_id, pattern_id,
      message log_text)
    WITH (optimize_top_k = 'bm25(1.2, 0.75)')`,
    "VACUUM (REFRESH_TABLE) log_events",
  ]
}

export function fixtureConnection(database: string): Connection {
  return { ...samplesConnection(), database }
}

/** Creates the database if needed and rebuilds its tables; idempotent. */
export async function buildFixtureDatabase(
  database: string,
  rows: readonly FixtureRow[]
): Promise<void> {
  await rebuildDatabase(fixtureConnection(database), statements(rows))
}
