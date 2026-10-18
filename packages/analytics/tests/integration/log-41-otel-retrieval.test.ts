/** Independent applicability oracle: cloned fixture metadata, raw Parquet/OTLP rows,
 * hand-authored vectors. The loaded source DB is read-only; only this test DB changes.
 */
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { searchLogsOutputSchema } from "@workspace/domain/tools/search-logs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import {
  buildRetrievalSnapshot,
  messageDigest,
  retrievalDigest,
} from "../../src/retrieval.ts"
import { buildFixtureDatabase, fixtureConnection } from "./fixtures.ts"
import { loadEnv, otelSamplesConnection, temporaryDir } from "./helpers.ts"

loadEnv()
const DATABASE = `log_insights_log41_otel_retrieval_${process.pid}`
const FROM = "2025-09-23T00:29:24.037000Z"
const TO = "2025-09-23T00:29:24.041000Z"
const REPLAY_FROM = "2025-09-23T00:20:00.000000Z"
// The committed sample's last event is at .000997; the visible span ends 1 µs later.
const REPLAY_TO = "2025-09-23T00:20:00.000998Z"
const BOUNDARY = "2025-09-23T00:29:24.039037200Z"
const QUERY = "log41 independently seeded semantic query"
const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
const eventSchema = z.object({
  event_id: z.coerce.number().int().safe(),
  component: z.string(),
  level: z.string(),
  message: z.string(),
})
const call = () => ({
  client: "test" as const,
  signal: new AbortController().signal,
})
let sourceDb: Database
let db: Database
let directory: string
let previousDirectory: string | undefined
let registry: Registry
let receipts: FileReceiptStore
const snapshots: string[] = []
let otelEvents: z.infer<typeof eventSchema>[]
let replayEvents: z.infer<typeof eventSchema>[]

const TABLES = [
  {
    name: "otel_sources",
    columns: [
      ["file_index", "INTEGER"],
      ["url", "VARCHAR"],
      ["size", "BIGINT"],
      ["etag", "VARCHAR"],
      ["last_modified", "TIMESTAMPTZ"],
      ["assigned_from", "TIMESTAMPTZ_NS"],
      ["assigned_to", "TIMESTAMPTZ_NS"],
    ],
  },
  {
    name: "otel_row_groups",
    columns: [
      ["file_index", "INTEGER"],
      ["compressed_bytes", "BIGINT"],
      ["ts_min", "TIMESTAMPTZ_NS"],
      ["ts_max", "TIMESTAMPTZ_NS"],
    ],
  },
  {
    name: "otel_reference",
    columns: [
      ["index_name", "VARCHAR"],
      ["source_glob", "VARCHAR"],
      ["window_from", "TIMESTAMPTZ"],
      ["window_to", "TIMESTAMPTZ"],
      ["built_at", "TIMESTAMPTZ"],
      ["build_ms", "DOUBLE"],
      ["events", "BIGINT"],
      ["duplicates_removed", "BIGINT"],
      ["mapping_version", "VARCHAR"],
    ],
  },
  {
    name: "otel_replay",
    columns: [
      ["replay_id", "VARCHAR"],
      ["replayed_at", "TIMESTAMPTZ"],
      ["records", "BIGINT"],
      ["fixture_path", "VARCHAR"],
      ["fixture_sha256", "VARCHAR"],
      ["source_url", "VARCHAR"],
      ["listener_table", "VARCHAR"],
      ["index_name", "VARCHAR"],
      ["index_built_at", "TIMESTAMPTZ"],
    ],
  },
  {
    name: "otel_replay_events",
    columns: [
      ["event_id", "BIGINT"],
      ["dataset", "VARCHAR"],
      ["ts", "TIMESTAMPTZ_NS"],
      ["level", "VARCHAR"],
      ["component", "VARCHAR"],
      ["source_type", "VARCHAR"],
      ["is_error", "BOOLEAN"],
      ["trace_id", "VARCHAR"],
      ["span_id", "VARCHAR"],
      ["severity_number", "INTEGER"],
      ["message", "VARCHAR"],
    ],
  },
] as const

beforeAll(async () => {
  sourceDb = createDatabase(otelSamplesConnection())
  await buildFixtureDatabase(DATABASE, [
    {
      event_id: 1,
      dataset: "bgl",
      ts: "2005-07-01T00:00:00Z",
      component: "KERNEL",
      level: "INFO",
      message: "unrelated local source",
    },
  ])
  db = createDatabase(fixtureConnection(DATABASE))
  for (const table of TABLES) {
    await db.query(
      `CREATE TABLE ${table.name} (${table.columns.map(([name, type]) => `${name} ${type}`).join(",")})`,
      [],
      call().signal
    )
    const projection = table.columns
      .map(([name, type]) =>
        type.startsWith("TIMESTAMP") ? `${name}::VARCHAR AS ${name}` : name
      )
      .join(",")
    const result = await sourceDb.query(
      `SELECT ${projection} FROM ${table.name}`,
      [],
      call().signal
    )
    for (let start = 0; start < result.rows.length; start += 50) {
      const batch = result.rows.slice(start, start + 50)
      const params = batch.flatMap((row) =>
        table.columns.map(([name]) => valueSchema.parse(row[name]))
      )
      const values = batch
        .map(
          (_, row) =>
            `(${table.columns.map(([, type], column) => `$${row * table.columns.length + column + 1}::${type}`).join(",")})`
        )
        .join(",")
      await db.query(
        `INSERT INTO ${table.name} VALUES ${values}`,
        params,
        call().signal
      )
    }
  }
  await db.query(
    `CREATE TABLE otel_ref AS SELECT "Timestamp" AS ts,"SeverityText" AS level,"ServiceName" AS component,"ScopeName" AS source_type,"TraceId" AS trace_id,"SpanId" AS span_id,"SeverityNumber" AS severity_number,"Body" AS message,file_row_number
    FROM read_parquet('/data/raw/otel/part_00[0-1].parquet',filename=true,file_row_number=true)
    WHERE "Timestamp">=$1::TIMESTAMPTZ_NS AND "Timestamp"<$2::TIMESTAMPTZ_NS
      AND ((filename='/data/raw/otel/part_000.parquet' AND "Timestamp"<$3::TIMESTAMPTZ_NS) OR (filename='/data/raw/otel/part_001.parquet' AND "Timestamp">=$3::TIMESTAMPTZ_NS))`,
    [FROM, TO, BOUNDARY],
    call().signal
  )
  await db.query(
    "CREATE INDEX otel_ref_idx ON otel_ref USING inverted(component,level,trace_id,message log_text) INCLUDE(ts,file_row_number)",
    [],
    call().signal
  )
  await db.query(
    "CREATE INDEX otel_replay_idx ON otel_replay_events USING inverted(component,level,trace_id,message log_text) INCLUDE(event_id,dataset,ts,level,component,source_type,is_error,trace_id,span_id,severity_number,message)",
    [],
    call().signal
  )
  await db.query(
    "INSERT INTO corpus_stats SELECT 'otel',min(ts)::TIMESTAMPTZ,max(ts)::TIMESTAMPTZ FROM otel_ref",
    [],
    call().signal
  )
  await db.query(
    "INSERT INTO corpus_stats SELECT 'otel_replay',min(ts)::TIMESTAMPTZ,max(ts)::TIMESTAMPTZ FROM otel_replay_events",
    [],
    call().signal
  )
  await db.query("VACUUM (REFRESH_TABLE) otel_ref", [], call().signal)
  await db.query("VACUUM (REFRESH_TABLE) otel_replay_events", [], call().signal)
  const otelRaw = await db.query(
    `WITH raw AS (SELECT 1000000000000::BIGINT+CASE WHEN ts>=$1::TIMESTAMPTZ_NS THEN 10000000000::BIGINT ELSE 0::BIGINT END+file_row_number AS event_id,component,level,message FROM otel_ref), ranked AS (SELECT *,row_number() OVER(PARTITION BY component ORDER BY event_id) AS n FROM raw) SELECT event_id,component,level,message FROM ranked WHERE n=1 ORDER BY event_id LIMIT 3`,
    [BOUNDARY],
    call().signal
  )
  otelEvents = z.array(eventSchema).length(3).parse(otelRaw.rows)
  const replayRaw = await db.query(
    "WITH ranked AS (SELECT *,row_number() OVER(PARTITION BY component ORDER BY event_id) AS n FROM otel_replay_events) SELECT event_id,component,level,message FROM ranked WHERE n=1 ORDER BY event_id LIMIT 3",
    [],
    call().signal
  )
  replayEvents = z.array(eventSchema).length(3).parse(replayRaw.rows)
  directory = await temporaryDir("log41-otel-retrieval-")
  previousDirectory = process.env.LOG_INSIGHTS_RETRIEVAL_DIR
  process.env.LOG_INSIGHTS_RETRIEVAL_DIR = directory
  receipts = new FileReceiptStore(directory)
  registry = createRegistry({ db, receipts, log: () => undefined })
})
afterAll(async () => {
  if (previousDirectory === undefined)
    delete process.env.LOG_INSIGHTS_RETRIEVAL_DIR
  else process.env.LOG_INSIGHTS_RETRIEVAL_DIR = previousDirectory
  if (sourceDb !== undefined) await sourceDb.dispose()
  if (db !== undefined) {
    for (const id of snapshots) {
      await db.query(
        `DROP TABLE IF EXISTS log_retrieval_${id.slice(0, 32)} CASCADE`,
        [],
        call().signal
      )
      await db.query(
        `DROP TEXT SEARCH DICTIONARY IF EXISTS log_retrieval_${id.slice(0, 32)}_text`,
        [],
        call().signal
      )
    }
    await db.dispose()
  }
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true })
})

async function build(
  source: Record<string, unknown>,
  events: z.infer<typeof eventSchema>[]
) {
  const manifest = await buildRetrievalSnapshot(
    db,
    {
      version: 1,
      provider: "independent-synthetic-fixture",
      model: "hand-authored-orthogonal-vectors",
      model_version: "v1",
      dimensions: 3,
      normalization: "l2",
      preprocessing_version: "message-v1",
      data_version: "dv_fixture000000000",
      source,
      events: events.map((event, index) => ({
        event_id: event.event_id,
        message_sha256: messageDigest(event.message),
        embedding: [0, 1, 2].map((axis) => (axis === index ? 1 : 0)),
      })),
      queries: [{ query: QUERY, embedding: [1, 0, 0] }],
    },
    directory,
    call().signal
  )
  snapshots.push(manifest.snapshot_id)
  return manifest
}
async function search(input: Record<string, unknown>) {
  const outcome = await registry.runTool("search_logs", input, call())
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
  return {
    ...outcome.result,
    data: searchLogsOutputSchema.parse(outcome.result.data),
  }
}

describe("LOG-41 OTel retrieval applicability with independent SQL IDs", () => {
  it("direct snapshots answer their pinned coverage outside the indexed reference bounds", async () => {
    // Only this test's own metadata changes; the mounted source Parquet is immutable.
    await db.query(
      "UPDATE otel_reference SET window_from='2025-09-23T00:29:24.040000Z'::TIMESTAMPTZ",
      [],
      call().signal
    )
    try {
      const manifest = await build(
        { dataset: "otel", path: "direct_scan", from: FROM, to: TO },
        otelEvents
      )
      const first = otelEvents[0]
      if (first === undefined)
        throw new Error("Missing independent source candidate")
      for (const match of ["semantic", "hybrid"]) {
        const result = await search({
          dataset: "otel",
          from: FROM,
          to: TO,
          match,
          retrieval_snapshot: manifest.snapshot_id,
          query: QUERY,
          limit: 1,
        })
        expect(result.data.hits.map((hit) => hit.event_id)).toEqual([
          first.event_id,
        ])
        expect(result.receipt.source).toMatchObject({
          kind: "remote_parquet",
          path: "direct_scan",
          window: { from: FROM, to: TO },
          index: null,
        })
      }
    } finally {
      await db.query(
        "UPDATE otel_reference SET window_from=$1::TIMESTAMPTZ",
        [FROM],
        call().signal
      )
    }
  })
  for (const path of ["direct_scan", "indexed_window"] as const) {
    it(`${path}: semantic/hybrid preserve IDs, provenance and preselection filters`, async () => {
      const manifest = await build(
        { dataset: "otel", path, from: FROM, to: TO },
        otelEvents
      )
      const first = otelEvents[0]
      const second = otelEvents[1]
      if (first === undefined || second === undefined)
        throw new Error("Missing independent source candidates")
      for (const match of ["semantic", "hybrid"]) {
        const input = {
          dataset: "otel",
          from: FROM,
          to: TO,
          match,
          retrieval_snapshot: manifest.snapshot_id,
          query: QUERY,
          limit: 1,
        }
        const result = await search(input)
        expect(result.data.hits.map((hit) => hit.event_id)).toEqual([
          first.event_id,
        ])
        expect(result.data.total_matches).toBeNull()
        expect(result.notes.join(" ")).toContain("immutable copied rows")
        expect(result.notes.join(" ")).not.toContain("this count is exact")
        expect(result.receipt.source).toMatchObject({
          kind: "remote_parquet",
          dataset: "otel",
          path,
        })
        expect(result.receipt.scope.windows).toEqual([
          { dataset: "otel", from: FROM, to: TO },
        ])
        const filtered = await search({
          ...input,
          components: [second.component],
        })
        expect(filtered.data.hits.map((hit) => hit.event_id)).toEqual([
          second.event_id,
        ])
        expect(filtered.data.hits[0]?.component).toBe(second.component)
        expect(
          (await receipts.get(filtered.receipt.receipt_id))?.source
        ).toEqual(filtered.receipt.source)
      }
    })
  }
  it("replay: seeded semantic/hybrid candidates retain the real replay identity", async () => {
    const manifest = await build({ dataset: "otel_replay" }, replayEvents)
    const first = replayEvents[0]
    const second = replayEvents[1]
    if (first === undefined || second === undefined)
      throw new Error("Missing independent replay candidates")
    const expectedSource = await db.query(
      "SELECT replay_id,fixture_sha256,listener_table FROM otel_replay",
      [],
      call().signal
    )
    for (const match of ["semantic", "hybrid"]) {
      const input = {
        dataset: "otel_replay",
        from: REPLAY_FROM,
        to: REPLAY_TO,
        match,
        retrieval_snapshot: manifest.snapshot_id,
        query: QUERY,
        limit: 1,
      }
      const result = await search(input)
      expect(result.data.hits.map((hit) => hit.event_id)).toEqual([
        first.event_id,
      ])
      expect(result.receipt.source).toMatchObject({
        kind: "otlp_replay",
        dataset: "otel_replay",
        replay_id: expectedSource.rows[0]?.replay_id,
        fixture: { sha256: expectedSource.rows[0]?.fixture_sha256 },
        listener_table: expectedSource.rows[0]?.listener_table,
      })
      expect(result.notes.join(" ")).toContain("immutable copied rows")
      expect(result.notes.join(" ")).not.toContain("this count is exact")
      const filtered = await search({
        ...input,
        components: [second.component],
      })
      expect(filtered.data.hits.map((hit) => hit.event_id)).toEqual([
        second.event_id,
      ])
      const rerun = await registry.rerun(filtered.receipt.receipt_id, call())
      expect(rerun.ok ? rerun.matches : rerun.error).toEqual({
        signature: true,
        data_version: true,
        result_digest: true,
      })
    }
    const outside = await registry.runTool(
      "search_logs",
      {
        dataset: "otel_replay",
        from: REPLAY_FROM,
        to: "2025-09-23T00:20:00.001000Z",
        match: "semantic",
        retrieval_snapshot: manifest.snapshot_id,
        query: QUERY,
      },
      call()
    )
    expect(outside.ok ? null : outside.error).toMatchObject({
      code: "invalid_input",
    })
  })
  it("rejects a snapshot when the requested dataset differs", async () => {
    const manifest = await build({ dataset: "otel_replay" }, replayEvents)
    const outcome = await registry.runTool(
      "search_logs",
      {
        dataset: "otel",
        from: FROM,
        to: TO,
        query: QUERY,
        match: "semantic",
        retrieval_snapshot: manifest.snapshot_id,
      },
      call()
    )
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
    })
  })
  it("checks persisted snapshot pins before reading a representation index", async () => {
    const manifest = await build(
      { dataset: "otel", path: "indexed_window", from: FROM, to: TO },
      otelEvents
    )
    const { snapshot_id: _originalId, ...payload } = manifest
    if (payload.source?.kind !== "remote_parquet")
      throw new Error("Missing independent remote source")
    const [first, ...rest] = payload.source.files
    if (first === undefined) throw new Error("Missing original source pin")
    // Change only a manifest in this test's private directory. The underlying
    // file and the loaded source metadata remain unchanged.
    const changed = {
      ...payload,
      source: {
        ...payload.source,
        files: [{ ...first, bytes: first.bytes + 1 }, ...rest],
      },
    }
    const changedId = retrievalDigest(changed)
    await writeFile(
      join(directory, `${changedId}.json`),
      JSON.stringify({ ...changed, snapshot_id: changedId }),
      { flag: "wx" }
    )
    for (const match of ["semantic", "hybrid"]) {
      const outcome = await registry.runTool(
        "search_logs",
        {
          dataset: "otel",
          from: FROM,
          to: TO,
          query: QUERY,
          match,
          retrieval_snapshot: changedId,
        },
        call()
      )
      expect(outcome.ok ? null : outcome.error).toMatchObject({
        code: "source_changed",
      })
    }
  })
})
