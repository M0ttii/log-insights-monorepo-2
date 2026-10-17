import type { Connection } from "../../src/config.ts"
import { rebuildDatabase, samplesConnection } from "./helpers.ts"

/**
 * A synthetic OpenStack API database for latency_stats cases the 2k samples
 * do not contain: a 5xx next to 4xx, an access without latency, a request
 * ID on two accesses, an hour with log events but no API access and an
 * hour without any event (capture gap). Never the demo corpus: it lives in
 * its own database and is rebuilt by every run.
 *
 * Only the columns latency_stats reads are created, with the types of
 * corpus/sql (11, 25, 40); analytics cannot run the corpus loader (package
 * boundary), so this is a deliberately small, hand-written copy.
 *
 * Accesses (UTC, 2017-05-14):
 *   10:00:00 GET  /v2/<ID>/servers/detail            200  100 ms  req-1
 *   10:01:00 GET  /v2/<ID>/servers/detail            200  200 ms  req-2
 *   10:02:00 GET  /v2/<ID>/servers/detail            200  300 ms  req-3
 *   10:03:00 GET  /v2/<ID>/servers/detail            200  400 ms  req-4
 *   10:04:00 GET  /v2/<ID>/servers/detail            503 1000 ms  req-5
 *   10:05:00 POST /v2/<ID>/os-server-external-events 404   50 ms  req-6
 *   10:06:00 GET  /v2/<ID>/os-server-external-events 404   70 ms  –
 *   10:07:00 GET  /latest/meta-data/                 200    –     –
 *   13:30:00 GET  /v2/<ID>/servers/detail            200  250 ms  req-1
 * plus a non-access OpenStack line at 11:15 (nothing at 12:00–13:00) and a
 * BGL line, which never counts.
 */

const FIXTURE_DATABASE = "log_insights_latency_fixtures"

type Access = {
  ts: string
  method: string | null
  endpoint: string | null
  status: number | null
  latency: number | null
  request: string | null
}

const SERVERS = "/v2/<ID>/servers/detail"
const EVENTS = "/v2/<ID>/os-server-external-events"
const METADATA = "/latest/meta-data/"

const ROWS: readonly Access[] = [
  {
    ts: "10:00:00",
    method: "GET",
    endpoint: SERVERS,
    status: 200,
    latency: 100,
    request: "req-1",
  },
  {
    ts: "10:01:00",
    method: "GET",
    endpoint: SERVERS,
    status: 200,
    latency: 200,
    request: "req-2",
  },
  {
    ts: "10:02:00",
    method: "GET",
    endpoint: SERVERS,
    status: 200,
    latency: 300,
    request: "req-3",
  },
  {
    ts: "10:03:00",
    method: "GET",
    endpoint: SERVERS,
    status: 200,
    latency: 400,
    request: "req-4",
  },
  {
    ts: "10:04:00",
    method: "GET",
    endpoint: SERVERS,
    status: 503,
    latency: 1000,
    request: "req-5",
  },
  {
    ts: "10:05:00",
    method: "POST",
    endpoint: EVENTS,
    status: 404,
    latency: 50,
    request: "req-6",
  },
  {
    ts: "10:06:00",
    method: "GET",
    endpoint: EVENTS,
    status: 404,
    latency: 70,
    request: null,
  },
  {
    ts: "10:07:00",
    method: "GET",
    endpoint: METADATA,
    status: 200,
    latency: null,
    request: null,
  },
  {
    ts: "11:15:00",
    method: null,
    endpoint: null,
    status: null,
    latency: null,
    request: "req-7",
  },
  {
    ts: "13:30:00",
    method: "GET",
    endpoint: SERVERS,
    status: 200,
    latency: 250,
    request: "req-1",
  },
]

export const LATENCY_FIXTURE = { SERVERS, EVENTS, METADATA }

const text = (value: string | null) =>
  value === null ? "NULL::VARCHAR" : `'${value.replaceAll("'", "''")}'`

function valuesRow(row: Access, index: number): string {
  return `(${10_000_001 + index}::BIGINT, 'openstack', '2017-05-14T${row.ts}.000000Z'::TIMESTAMPTZ, 'INFO', 'nova-api', ${text(row.request)}, ${text(row.method)}, ${text(row.endpoint)}, ${row.status === null ? "NULL::INTEGER" : `${row.status}::INTEGER`}, ${row.latency === null ? "NULL::DOUBLE" : `${row.latency}::DOUBLE`})`
}

const BGL_ROW =
  "(1::BIGINT, 'bgl', '2005-06-03T22:42:50.000000Z'::TIMESTAMPTZ, 'INFO', 'KERNEL', NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, NULL::INTEGER, NULL::DOUBLE)"

const STATEMENTS = [
  `CREATE OR REPLACE TABLE log_events AS SELECT * FROM (VALUES ${[BGL_ROW, ...ROWS.map(valuesRow)].join(", ")}) AS t(event_id, dataset, ts, level, component, request_id, http_method, endpoint, http_status, latency_ms)`,
  "CREATE OR REPLACE TABLE corpus_stats AS SELECT dataset, min(ts) AS first_ts, max(ts) AS last_ts FROM log_events GROUP BY dataset",
  "CREATE OR REPLACE TABLE load_manifest AS SELECT 'dv_latencyfixture00' AS data_version",
]

export function latencyFixtureConnection(): Connection {
  return { ...samplesConnection(), database: FIXTURE_DATABASE }
}

/** Creates the database if needed and rebuilds its tables; idempotent. */
export async function buildLatencyFixtures(): Promise<void> {
  await rebuildDatabase(latencyFixtureConnection(), STATEMENTS)
}
