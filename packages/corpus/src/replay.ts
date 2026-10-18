import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { Client } from "pg"

import { DATASETS } from "@workspace/domain/datasets"

import type { ReplayLoad } from "./sources.ts"

/**
 * OTLP/HTTP replay of the otel_replay fixture (LOG-35, design D7). The
 * loader clears the previous replay rows, posts the committed records once
 * as one OTLP/JSON ExportLogsServiceRequest to SereneDB's own listener on
 * 127.0.0.1 (serened.conf, Basic auth with the SereneDB role), makes the
 * export visible with `VACUUM (REFRESH_TABLE)` (exports become visible
 * asynchronously otherwise, LOG-35 probe § 7.2) and verifies the count.
 * SereneDB does not deduplicate exports: the replayer never resends, and
 * the load fails when the count differs.
 */

/** One record of the committed fixture (packages/corpus/src/replay-fixture.ts). */
export type ReplayRecord = {
  fixture_row: number
  file_row_number: string
  time_unix_nano: string
  trace_id: string
  span_id: string
  trace_flags: number
  severity_text: string
  severity_number: number
  service_name: string
  body: string
  scope_name: string
  scope_version: string
  resource: Record<string, string>
}

type FixtureDocument = {
  source: string
  selection: string
  records: ReplayRecord[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const DIGITS = /^\d+$/

function parseRecord(value: unknown, index: number): ReplayRecord {
  if (!isRecord(value)) throw new Error(`fixture record ${index} is no object`)
  const text = (key: string): string => {
    const field = value[key]
    if (typeof field !== "string")
      throw new Error(`fixture record ${index}: ${key} is not a string`)
    return field
  }
  const int = (key: string): number => {
    const field = value[key]
    if (typeof field !== "number" || !Number.isSafeInteger(field))
      throw new Error(`fixture record ${index}: ${key} is not an integer`)
    return field
  }
  const resource = value["resource"]
  if (
    !isRecord(resource) ||
    !Object.values(resource).every((v) => typeof v === "string")
  )
    throw new Error(`fixture record ${index}: resource is not a string map`)
  const record: ReplayRecord = {
    fixture_row: int("fixture_row"),
    file_row_number: text("file_row_number"),
    time_unix_nano: text("time_unix_nano"),
    trace_id: text("trace_id"),
    span_id: text("span_id"),
    trace_flags: int("trace_flags"),
    severity_text: text("severity_text"),
    severity_number: int("severity_number"),
    service_name: text("service_name"),
    body: text("body"),
    scope_name: text("scope_name"),
    scope_version: text("scope_version"),
    resource: Object.fromEntries(
      Object.entries(resource).map(([k, v]) => [k, String(v)])
    ),
  }
  if (record.fixture_row !== index)
    throw new Error(
      `fixture record ${index} has fixture_row ${record.fixture_row}`
    )
  if (
    !DIGITS.test(record.time_unix_nano) ||
    !DIGITS.test(record.file_row_number)
  )
    throw new Error(`fixture record ${index}: times and row numbers are digits`)
  return record
}

/** Reads the committed fixture and checks it against its catalog pin. */
export async function readReplayFixture(
  load: ReplayLoad,
  corpusDir: string
): Promise<{ records: ReplayRecord[]; source: string }> {
  const bytes = await readFile(join(corpusDir, load.fixture.path))
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (bytes.length !== load.fixture.bytes || sha256 !== load.fixture.sha256)
    throw new Error(
      `${load.fixture.path} does not match its catalog pin (${load.fixture.bytes} bytes, sha256 ${load.fixture.sha256})`
    )
  const parsed: unknown = JSON.parse(bytes.toString("utf8"))
  if (!isRecord(parsed) || !Array.isArray(parsed["records"]))
    throw new Error(`${load.fixture.path} has no records`)
  const document: FixtureDocument = {
    source: String(parsed["source"]),
    selection: String(parsed["selection"]),
    records: parsed["records"].map((record, i) => parseRecord(record, i)),
  }
  if (document.records.length !== load.fixture.records)
    throw new Error(
      `${load.fixture.path} holds ${document.records.length} records, the catalog ${load.fixture.records}`
    )
  return { records: document.records, source: document.source }
}

/** The replay of one load: its ID and the time it was sent, in nanoseconds. */
export type ReplayRun = {
  replayId: string
  /** ISO-8601 UTC with nine fractional digits (milliseconds from the clock). */
  replayedAt: string
  replayedAtNanos: string
}

/** A replay ID and time for a fixture; the ID hashes both. */
export function newReplayRun(
  fixtureSha256: string,
  now: Date = new Date()
): ReplayRun {
  const iso = now.toISOString()
  const replayedAt = `${iso.slice(0, 23)}000000Z`
  const replayedAtNanos = `${BigInt(now.getTime()) * 1_000_000n}`
  const replayId = `rp_${createHash("sha256").update(`${fixtureSha256}\0${replayedAt}`).digest("hex").slice(0, 12)}`
  return { replayId, replayedAt, replayedAtNanos }
}

type AnyValue = { stringValue: string } | { intValue: string }

const attribute = (key: string, value: AnyValue) => ({ key, value })

/**
 * The OTLP/JSON ExportLogsServiceRequest of the fixture: one resourceLogs
 * per record (its own resource attributes and scope), the original
 * timeUnixNano, observedTimeUnixNano = replay time, and two log attributes
 * that identify the replay and the fixture row. Values stay as in the
 * fixture; empty IDs and severity 0 are sent as they are (SereneDB stores
 * them as NULL).
 */
export function replayPayload(
  records: readonly ReplayRecord[],
  run: ReplayRun
): string {
  const { attributes } = DATASETS.otel_replay.replay
  return JSON.stringify({
    resourceLogs: records.map((record) => ({
      resource: {
        attributes: Object.entries(record.resource).map(([key, value]) =>
          attribute(key, { stringValue: value })
        ),
      },
      scopeLogs: [
        {
          scope: { name: record.scope_name, version: record.scope_version },
          logRecords: [
            {
              timeUnixNano: record.time_unix_nano,
              observedTimeUnixNano: run.replayedAtNanos,
              severityNumber: record.severity_number,
              severityText: record.severity_text,
              body: { stringValue: record.body },
              traceId: record.trace_id,
              spanId: record.span_id,
              flags: record.trace_flags,
              attributes: [
                attribute(attributes.replayId, { stringValue: run.replayId }),
                attribute(attributes.fixtureRow, {
                  intValue: String(record.fixture_row),
                }),
              ],
            },
          ],
        },
      ],
    })),
  })
}

const POST_TIMEOUT_MS = 30_000

/** POSTs an OTLP/JSON body to the listener; throws unless it answers 200 without rejections. */
export async function postOtlp(
  url: string,
  credentials: { user: string; password: string },
  body: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const auth = Buffer.from(
    `${credentials.user}:${credentials.password}`
  ).toString("base64")
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${auth}`,
    },
    body,
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  })
  const text = await response.text()
  if (response.status !== 200)
    throw new Error(
      `OTLP export to ${url} answered HTTP ${response.status}: ${text.slice(0, 200)}`
    )
  const parsed: unknown = text === "" ? {} : JSON.parse(text)
  const partial = isRecord(parsed) ? parsed["partialSuccess"] : undefined
  if (isRecord(partial) && Number(partial["rejectedLogRecords"] ?? 0) > 0)
    throw new Error(
      `OTLP export to ${url} rejected ${String(partial["rejectedLogRecords"])} records`
    )
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/
const ATTRIBUTE = /^[a-z_.]+$/

/** The listener table, checked before it becomes SQL text. */
export function replayTable(load: ReplayLoad): string {
  if (!IDENTIFIER.test(load.schema) || !IDENTIFIER.test(load.table))
    throw new Error(`invalid listener table ${load.schema}.${load.table}`)
  return `${load.schema}.${load.table}`
}

function replayAttribute(): string {
  const key = DATASETS.otel_replay.replay.attributes.replayId
  if (!ATTRIBUTE.test(key)) throw new Error(`invalid attribute ${key}`)
  return key
}

async function replayRows(
  client: Client,
  table: string,
  replayId: string | null
): Promise<number> {
  const key = replayAttribute()
  const { rows } = await client.query<{ n: string }>(
    replayId === null
      ? `SELECT count(*)::VARCHAR AS n FROM ${table} WHERE log_attributes ->> '${key}' IS NOT NULL`
      : `SELECT count(*)::VARCHAR AS n FROM ${table} WHERE log_attributes ->> '${key}' = $1`,
    replayId === null ? [] : [replayId]
  )
  return Number(rows[0]?.n)
}

/**
 * Clears every previous replay row (rows that carry a replay ID; other
 * exports to the listener stay), posts the fixture once, refreshes and
 * verifies that exactly the fixture's records arrived.
 */
export async function replay(
  client: Client,
  load: ReplayLoad,
  records: readonly ReplayRecord[],
  run: ReplayRun,
  target: { url: string; user: string; password: string },
  log: (message: string) => void
): Promise<void> {
  const table = replayTable(load)
  const exists = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2",
    [load.schema, load.table]
  )
  if (exists.rowCount === 0)
    throw new Error(
      `${table} does not exist in database ${load.database}: SereneDB runs without the OTLP listener of serened.conf. Recreate the container with \`docker compose up -d serenedb\` (the data volume is kept).`
    )
  const key = replayAttribute()
  await client.query(
    `DELETE FROM ${table} WHERE log_attributes ->> '${key}' IS NOT NULL`
  )
  await client.query(`VACUUM (REFRESH_TABLE) ${table}`)
  const left = await replayRows(client, table, null)
  if (left !== 0)
    throw new Error(`${left} previous replay rows are still in ${table}`)
  await postOtlp(target.url, target, replayPayload(records, run))
  await client.query(`VACUUM (REFRESH_TABLE) ${table}`)
  const arrived = await replayRows(client, table, run.replayId)
  if (arrived !== records.length)
    throw new Error(
      `replay ${run.replayId}: ${arrived} rows arrived in ${table}, expected ${records.length} (SereneDB does not deduplicate exports)`
    )
  log(
    `  replayed ${records.length} records as ${run.replayId} at ${run.replayedAt} to ${target.url} (${table} in ${load.database})`
  )
}
