import type { Connection } from "../../src/config.ts"
import { rebuildDatabase, samplesConnection } from "./helpers.ts"

/**
 * A synthetic counting database for cases the 2k samples do not contain:
 * an unowned component (S-05; on the corpus that is SERV_NET with 3 events,
 * absent from the samples) and exact R-06 boundaries for compare. Never the
 * demo corpus: it lives in its own database and is rebuilt by every run.
 *
 * Only the relations count_events reads are created, with the columns of
 * corpus/sql (25–40); analytics cannot run the corpus loader (package
 * boundary), so this is a deliberately small, hand-written copy. The
 * ownership rows are copied from corpus/sql/30_ownership.sql for the
 * components used here; SERV_NET has no row there either.
 */

const FIXTURE_DATABASE = "log_insights_count_fixtures"

type Row = {
  dataset: "bgl" | "openstack"
  ts: string
  level: string
  component: string
  node: string | null
  http_status: number | null
}

/** `count` KERNEL events of one level, one second apart from midnight of `day`. */
function kernel(day: string, level: string, count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    dataset: "bgl" as const,
    ts: `${day}T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000000Z`,
    level,
    component: "KERNEL",
    node: "R02-M1-N0-C:J12-U11",
    http_status: null,
  }))
}

/**
 * Comparison days, B = 2005-07-01 and C = 2005-07-02 (UTC), KERNEL by level:
 * FATAL 20 → 40 (doubled, +20), ERROR 19 → 38 (doubled, +19),
 * FAILURE 5 → 0, SEVERE 0 → 3. The first C event is exactly at the start of
 * C; one event lies exactly at the end of C and one 1 µs before B, both
 * outside the comparison.
 */
export const COMPARE_BASELINE = {
  from: "2005-07-01T00:00:00Z",
  to: "2005-07-02T00:00:00Z",
}
export const COMPARE_CURRENT = {
  from: "2005-07-02T00:00:00Z",
  to: "2005-07-03T00:00:00Z",
}

const COMPARE_ROWS: readonly Row[] = [
  ...kernel("2005-07-01", "FATAL", 20),
  ...kernel("2005-07-01", "ERROR", 19),
  ...kernel("2005-07-01", "FAILURE", 5),
  ...kernel("2005-07-02", "FATAL", 40),
  ...kernel("2005-07-02", "ERROR", 38),
  ...kernel("2005-07-02", "SEVERE", 3),
  ...kernel("2005-07-03", "FATAL", 1),
  {
    dataset: "bgl",
    ts: "2005-06-30T23:59:59.999999Z",
    level: "INFO",
    component: "KERNEL",
    node: "R02-M1-N0-C:J12-U11",
    http_status: null,
  },
]

/**
 * BGL: 3 KERNEL (Compute Platform) on 2005-06-03, 2 SERV_NET (unowned) and
 * the 127 KERNEL comparison rows; OpenStack: 1 nova-api access.
 */
const ROWS: readonly Row[] = [
  ...[0, 1, 2].map((second) => ({
    dataset: "bgl" as const,
    ts: `2005-06-03T22:00:0${second}.000000Z`,
    level: "INFO",
    component: "KERNEL",
    node: "R02-M1-N0-C:J12-U11",
    http_status: null,
  })),
  ...[0, 1].map((second) => ({
    dataset: "bgl" as const,
    ts: `2005-06-03T23:00:0${second}.000000Z`,
    level: "INFO",
    component: "SERV_NET",
    node: null,
    http_status: null,
  })),
  {
    dataset: "openstack",
    ts: "2017-05-16T00:00:00.008000Z",
    level: "INFO",
    component: "nova-api",
    node: null,
    http_status: 200,
  },
  ...COMPARE_ROWS,
]

const text = (value: string | null) =>
  value === null ? "NULL::VARCHAR" : `'${value.replaceAll("'", "''")}'`

function valuesRow(row: Row, index: number): string {
  const eventId = row.dataset === "bgl" ? index + 1 : 10_000_000 + index + 1
  const rack = row.node === null ? null : row.node.slice(0, 3)
  return `(${eventId}::BIGINT, ${text(row.dataset)}, '${row.ts}'::TIMESTAMPTZ, ${text(row.level)}, ${text(row.component)}, ${text(row.node)}, ${text(rack)}, NULL::VARCHAR, false, false, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, ${row.http_status === null ? "NULL::INTEGER" : `${row.http_status}::INTEGER`}, ${text(`p_${row.component.toLowerCase()}`)}, 'fixture')`
}

const STATEMENTS = [
  `CREATE OR REPLACE TABLE log_events AS SELECT * FROM (VALUES ${ROWS.map(valuesRow).join(", ")}) AS t(event_id, dataset, ts, level, component, node, rack, alert_label, is_alert, is_error, request_id, instance_id, endpoint, http_status, pattern_id, message)`,
  "CREATE OR REPLACE TABLE ownership AS SELECT * FROM (VALUES ('bgl', 'KERNEL', 'Compute Platform', 'fictional (Serene Platform)', 'fixture'), ('openstack', 'nova-api', 'API Gateway', 'fictional (Serene Platform)', 'fixture')) AS t(dataset, component, team, note, reason)",
  "CREATE OR REPLACE TABLE corpus_stats AS SELECT dataset, min(ts) AS first_ts, max(ts) AS last_ts FROM log_events GROUP BY dataset",
  "CREATE OR REPLACE TABLE load_manifest AS SELECT 'dv_countfixture0000' AS data_version",
]

export function countFixtureConnection(): Connection {
  return { ...samplesConnection(), database: FIXTURE_DATABASE }
}

/** Creates the database if needed and rebuilds its tables; idempotent. */
export async function buildCountFixtures(): Promise<void> {
  await rebuildDatabase(countFixtureConnection(), STATEMENTS)
}
