import type { Connection } from "../../src/config.ts"
import { rebuildDatabase, samplesConnection } from "./helpers.ts"

/**
 * A synthetic pattern database for recurring_patterns (U11): episode
 * boundaries (technical.md § 8.2, counterexamples 1 and 2), S-16, dominance,
 * dropped rank criteria, every R-10 status and a single episode over
 * several days. Never the demo corpus: it lives in its own database and is
 * rebuilt by every run.
 *
 * Each case has its own component, so a test scopes it with `components`.
 * Patterns carry readable IDs (p_…); the expected values in
 * recurring-patterns.test.ts were worked out by hand from the rows below,
 * not with the tool.
 *
 * Only the relations recurring_patterns reads are created, with the
 * columns of corpus/sql (25–40) it uses; analytics cannot run the corpus
 * loader (package boundary), so this is a deliberately small, hand-written
 * copy.
 */

const FIXTURE_DATABASE = "log_insights_pattern_fixtures"

type Row = {
  dataset: "bgl" | "openstack"
  ts: string
  pattern_id: string
  component: string
  level: string
  node?: string | null
  alert_label?: string | null
  instance_id?: string | null
  request_id?: string | null
  http_status?: number | null
}

const ERROR_LEVELS = new Set([
  "FATAL",
  "ERROR",
  "SEVERE",
  "FAILURE",
  "CRITICAL",
])

/** `count` events of a pattern, `stepSeconds` apart from `start`. */
function series(
  start: string,
  count: number,
  stepSeconds: number,
  row: Omit<Row, "ts">
): Row[] {
  const first = Date.parse(start)
  return Array.from({ length: count }, (_, i) => ({
    ...row,
    ts: new Date(first + i * stepSeconds * 1000).toISOString(),
  }))
}

const fatal = (pattern_id: string, component: string, node: string | null) =>
  ({ dataset: "bgl", pattern_id, component, level: "FATAL", node }) as const

/** Span anchors: the BGL data starts 2005-06-01 and ends 2005-12-31. */
const SPAN_ROWS: Row[] = [
  {
    dataset: "bgl",
    ts: "2005-06-01T00:00:00.000000Z",
    pattern_id: "p_start",
    component: "START",
    level: "INFO",
    node: "R00-M0-N0",
  },
  {
    dataset: "bgl",
    ts: "2005-12-31T00:00:00.000000Z",
    pattern_id: "p_end",
    component: "START",
    level: "INFO",
    node: "R00-M0-N0",
  },
]

/**
 * Counterexample 1 (A/B/A, component ABA): 00:00 on node A, 00:20 on B,
 * 00:40 on A. Unfiltered the gaps are 20 min: 1 episode on 2 nodes. With
 * node = A the gap is 40 min: 2 episodes on 1 node.
 * Counterexample 2 (component TIE): two events at the same first instant:
 * 1 episode, example = the lower event_id.
 * Gap boundary (component GAP): exactly 30 min starts a new episode
 * (2 episodes), 1 µs less does not (1 episode).
 */
export const NODE_A = "R01-M0-N0-C:J02-U01"
const NODE_B = "R02-M0-N0-C:J02-U01"
const EPISODE_ROWS: Row[] = [
  { ...fatal("p_aba", "ABA", NODE_A), ts: "2005-07-01T00:00:00.000000Z" },
  { ...fatal("p_aba", "ABA", NODE_B), ts: "2005-07-01T00:20:00.000000Z" },
  { ...fatal("p_aba", "ABA", NODE_A), ts: "2005-07-01T00:40:00.000000Z" },
  { ...fatal("p_tie", "TIE", NODE_A), ts: "2005-07-01T00:00:00.000000Z" },
  { ...fatal("p_tie", "TIE", NODE_B), ts: "2005-07-01T00:00:00.000000Z" },
  { ...fatal("p_gap30", "GAP", NODE_A), ts: "2005-07-01T00:00:00.000000Z" },
  { ...fatal("p_gap30", "GAP", NODE_A), ts: "2005-07-01T00:30:00.000000Z" },
  { ...fatal("p_gap29", "GAP", NODE_A), ts: "2005-07-01T00:00:00.000000Z" },
  { ...fatal("p_gap29", "GAP", NODE_A), ts: "2005-07-01T00:29:59.999999Z" },
]

/**
 * S-16 (component S16, August 2005, nothing in July): p_burst has the most
 * lines, 500 within 500 s on one node plus one event on 2005-08-20 on the
 * same node: 501 events, 2 episodes, 1 node, alert label KERNDTLB. p_wide
 * has one event a day on 2005-08-01 … 2005-08-05, each on another node:
 * 5 events, 5 episodes, 5 nodes. Investigation order: p_wide first
 * (episodes, then breadth); p_burst leads in change (+501 against +5), so
 * neither dominates: a trade-off.
 */
const S16_ROWS: Row[] = [
  ...series("2005-08-10T12:00:00Z", 500, 1, {
    ...fatal("p_burst", "S16", NODE_A),
    alert_label: "KERNDTLB",
  }),
  {
    ...fatal("p_burst", "S16", NODE_A),
    alert_label: "KERNDTLB",
    ts: "2005-08-20T12:00:00.000000Z",
  },
  ...[1, 2, 3, 4, 5].map((day) => ({
    ...fatal("p_wide", "S16", `R0${day}-M0-N0-C:J02-U01`),
    level: day === 5 ? "ERROR" : "FATAL",
    ts: `2005-08-0${day}T06:00:00.000000Z`,
  })),
]

/**
 * Dominance (component DOM, August 2005): p_dom1 4 episodes on 4 nodes
 * (+4), p_dom2 2 episodes on 2 nodes (+2): p_dom1 is ahead everywhere,
 * clear priority 1.
 * Dropped breadth (component NONODE, August 2005): p_nn_some has one of its
 * two events without a node, so breadth is not determinable for it.
 */
const DOMINANCE_ROWS: Row[] = [
  ...[1, 2, 3, 4].map((day) => ({
    ...fatal("p_dom1", "DOM", `R0${day}-M1-N0-C:J02-U01`),
    ts: `2005-08-1${day}T06:00:00.000000Z`,
  })),
  ...[1, 2].map((day) => ({
    ...fatal("p_dom2", "DOM", `R0${day}-M2-N0-C:J02-U01`),
    ts: `2005-08-2${day}T06:00:00.000000Z`,
  })),
  {
    ...fatal("p_nn_some", "NONODE", NODE_A),
    ts: "2005-08-01T06:00:00.000000Z",
  },
  { ...fatal("p_nn_some", "NONODE", null), ts: "2005-08-02T06:00:00.000000Z" },
  { ...fatal("p_nn_all", "NONODE", NODE_B), ts: "2005-08-03T06:00:00.000000Z" },
]

/**
 * R-10 (component STAT): C = 2005-10-02, B = 2005-10-01 (UTC days).
 * p_new: first events ever in C (2) → new. p_esc: B 20, C 40 → escalating.
 * p_reap: one event on 2005-09-01 on NODE_A, none in B, one in C on NODE_B
 * → reappeared; with node = NODE_B there is no earlier event → new.
 * p_ong: B 5, C 5 → ongoing. p_quiet: B 3, C 0 → quiet.
 */
export const STATUS_BASELINE = {
  from: "2005-10-01T00:00:00Z",
  to: "2005-10-02T00:00:00Z",
}
export const STATUS_CURRENT = {
  from: "2005-10-02T00:00:00Z",
  to: "2005-10-03T00:00:00Z",
}
const STATUS_ROWS: Row[] = [
  ...series("2005-10-02T01:00:00Z", 2, 60, fatal("p_new", "STAT", NODE_A)),
  ...series("2005-10-01T01:00:00Z", 20, 60, fatal("p_esc", "STAT", NODE_A)),
  ...series("2005-10-02T01:00:00Z", 40, 60, fatal("p_esc", "STAT", NODE_A)),
  { ...fatal("p_reap", "STAT", NODE_A), ts: "2005-09-01T01:00:00.000000Z" },
  { ...fatal("p_reap", "STAT", NODE_B), ts: "2005-10-02T05:00:00.000000Z" },
  ...series("2005-10-01T03:00:00Z", 5, 60, fatal("p_ong", "STAT", NODE_A)),
  ...series("2005-10-02T03:00:00Z", 5, 60, fatal("p_ong", "STAT", NODE_A)),
  ...series("2005-10-01T04:00:00Z", 3, 60, fatal("p_quiet", "STAT", NODE_A)),
]

/**
 * One episode over three days (component LONG, A-10.3): an event every
 * 20 min from 2005-11-01T23:40 to 2005-11-03T00:20 (75 events) – 1
 * episode, not recurring, 3 active days, 1 active week (Tuesday–Thursday).
 */
const LONG_ROWS: Row[] = series(
  "2005-11-01T23:40:00Z",
  75,
  20 * 60,
  fatal("p_long", "LONG", NODE_A)
)

/**
 * OpenStack: os_err 2 ERROR events an hour apart on instances i-1 and i-2
 * (requests req-1, req-2); os_503 one INFO access with HTTP 503 and no
 * instance (req-3), a candidate as a failed API access (R-08); os_info 3
 * INFO accesses with 200, no candidate.
 */
const OPENSTACK_ROWS: Row[] = [
  {
    dataset: "openstack",
    ts: "2017-05-15T00:00:00.000000Z",
    pattern_id: "os_err",
    component: "nova-compute",
    level: "ERROR",
    instance_id: "i-1",
    request_id: "req-1",
  },
  {
    dataset: "openstack",
    ts: "2017-05-15T01:00:00.000000Z",
    pattern_id: "os_err",
    component: "nova-compute",
    level: "ERROR",
    instance_id: "i-2",
    request_id: "req-2",
  },
  {
    dataset: "openstack",
    ts: "2017-05-15T02:00:00.000000Z",
    pattern_id: "os_503",
    component: "nova-api",
    level: "INFO",
    request_id: "req-3",
    http_status: 503,
  },
  ...series("2017-05-15T03:00:00Z", 3, 60, {
    dataset: "openstack",
    pattern_id: "os_info",
    component: "nova-api",
    level: "INFO",
    request_id: "req-4",
    http_status: 200,
  }),
]

const ROWS: readonly Row[] = [
  ...SPAN_ROWS,
  ...EPISODE_ROWS,
  ...S16_ROWS,
  ...DOMINANCE_ROWS,
  ...STATUS_ROWS,
  ...LONG_ROWS,
  ...OPENSTACK_ROWS,
]

const text = (value: string | null | undefined) =>
  value === null || value === undefined
    ? "NULL::VARCHAR"
    : `'${value.replaceAll("'", "''")}'`

/** event_id follows the row order, so the first of two equal instants has the lower ID. */
function valuesRow(row: Row, index: number): string {
  const eventId = row.dataset === "bgl" ? index + 1 : 10_000_000 + index + 1
  const node = row.node ?? null
  const rack = node === null ? null : node.slice(0, 3)
  const label = row.alert_label ?? null
  const isError = ERROR_LEVELS.has(row.level)
  const status = row.http_status ?? null
  return `(${eventId}::BIGINT, ${text(row.dataset)}, '${row.ts}'::TIMESTAMPTZ, ${text(row.level)}, ${text(row.component)}, ${text(node)}, ${text(rack)}, ${text(label)}, ${label !== null}, ${isError}, ${text(row.request_id)}, ${text(row.instance_id)}, ${status === null ? "NULL::INTEGER" : `${status}::INTEGER`}, ${text(row.pattern_id)}, ${text(`pattern ${row.pattern_id} <NUM>`)}, ${text(`message of ${row.pattern_id}`)})`
}

const STATEMENTS = [
  `CREATE OR REPLACE TABLE log_events AS SELECT * FROM (VALUES ${ROWS.map(valuesRow).join(", ")}) AS t(event_id, dataset, ts, level, component, node, rack, alert_label, is_alert, is_error, request_id, instance_id, http_status, pattern_id, pattern, message)`,
  "CREATE OR REPLACE TABLE ownership AS SELECT * FROM (VALUES ('bgl', 'S16', 'Compute Platform', 'fictional (Serene Platform)', 'fixture'), ('openstack', 'nova-compute', 'Compute Platform', 'fictional (Serene Platform)', 'fixture')) AS t(dataset, component, team, note, reason)",
  "CREATE OR REPLACE TABLE corpus_stats AS SELECT dataset, min(ts) AS first_ts, max(ts) AS last_ts FROM log_events GROUP BY dataset",
  "CREATE OR REPLACE TABLE load_manifest AS SELECT 'dv_patternfixture00' AS data_version, 'concept-fixture' AS rules_version, '1.0.0' AS pattern_rules_version",
]

export function patternFixtureConnection(): Connection {
  return { ...samplesConnection(), database: FIXTURE_DATABASE }
}

/** Creates the database if needed and rebuilds its tables; idempotent. */
export async function buildPatternFixtures(): Promise<void> {
  await rebuildDatabase(patternFixtureConnection(), STATEMENTS)
}
