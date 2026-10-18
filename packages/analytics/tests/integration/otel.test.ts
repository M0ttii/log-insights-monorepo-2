/**
 * The otel dataset (LOG-35) through the registry against SereneDB with the
 * committed Parquet fixtures loaded by `pnpm data:setup --samples --with
 * otel` (database log_insights_samples_otel): two files with the real
 * text_bench schema that share one boundary row.
 *
 * Expected values come from independent SQL written here over the fixture
 * files (read_parquet, regex, the half-open rule spelled out), never from
 * the tool or relation code under test.
 */
import { copyFile, mkdir, rm, utimes } from "node:fs/promises"
import { join } from "node:path"

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import {
  hostRawDir,
  loadEnv,
  otelSamplesConnection,
  rebuildDatabase,
  temporaryDir,
} from "./helpers.ts"

loadEnv()

const PART_0 = "/data/raw/otel/part_000.parquet"
const PART_1 = "/data/raw/otel/part_001.parquet"
/** ts_min of part_001 = ts_max of part_000 in the fixtures (catalog samples). */
const BOUNDARY = "2025-09-23 00:29:24.0390372+00"
const REFERENCE = {
  from: "2025-09-23T00:29:24.037000Z",
  to: "2025-09-23T00:29:24.041000Z",
}
/** A boundary-crossing window inside the fixtures. */
const CROSSING = {
  from: "2025-09-23T00:29:24.039000Z",
  to: "2025-09-23T00:29:24.039100Z",
}

let db: Database
let oracle: Client
let dir: string
let receipts: FileReceiptStore
let registry: Registry

beforeAll(async () => {
  db = createDatabase(otelSamplesConnection())
  oracle = new Client(otelSamplesConnection())
  await oracle.connect()
  await oracle.query("SET TimeZone = 'UTC'")
  dir = await temporaryDir("analytics-otel-")
  receipts = new FileReceiptStore(dir)
  registry = createRegistry({ db, receipts, log: () => undefined })
})

afterAll(async () => {
  await db.dispose()
  await oracle.end()
  await rm(dir, { recursive: true, force: true })
})

const call = () => ({
  client: "test" as const,
  signal: new AbortController().signal,
})

async function ok(tool: string, input: Record<string, unknown>) {
  const outcome = await registry.runTool(tool, input, call())
  if (!outcome.ok) throw new Error(`${tool}: ${outcome.error.message}`)
  return outcome.result
}

async function failure(
  tool: string,
  input: Record<string, unknown>,
  reg: Registry = registry
) {
  const outcome = await reg.runTool(tool, input, call())
  if (outcome.ok) throw new Error(`${tool} unexpectedly succeeded`)
  return outcome.error
}

async function scalar(sql: string): Promise<number> {
  const { rows } = await oracle.query<{ n: string }>(sql)
  return Number(rows[0]?.n)
}

/** Rows of [from, to) in one fixture, the half-open part of the window it answers for. */
function halfOpen(from: string, to: string, extra = "TRUE"): string {
  return (
    `(SELECT count(*) FROM read_parquet('${PART_0}') WHERE "Timestamp" >= '${from}'::TIMESTAMPTZ_NS AND "Timestamp" < least('${to}'::TIMESTAMPTZ_NS, '${BOUNDARY}'::TIMESTAMPTZ_NS) AND ${extra})` +
    ` + (SELECT count(*) FROM read_parquet('${PART_1}') WHERE "Timestamp" >= greatest('${from}'::TIMESTAMPTZ_NS, '${BOUNDARY}'::TIMESTAMPTZ_NS) AND "Timestamp" < '${to}'::TIMESTAMPTZ_NS AND ${extra})`
  )
}

const word = (term: string) =>
  `regexp_matches(lower("Body"), '(^|[^a-z0-9_])${term}([^a-z0-9_]|$)')`

describe("otel load and describe_corpus", () => {
  it("lists otel as a remote dataset with footer counts, the reference window and no patterns", async () => {
    const { data } = await ok("describe_corpus", {})
    const otel = (
      data as { datasets: Record<string, unknown>[] }
    ).datasets.find((row) => row["dataset"] === "otel")
    const naive = await scalar(
      `SELECT count(*) AS n FROM read_parquet('/data/raw/otel/part_00[0-1].parquet')`
    )
    const distinct = await scalar(
      `SELECT ${halfOpen("2025-09-23 00:29:24.037+00", "2025-09-23 00:29:24.041+00")} AS n`
    )
    expect(otel).toMatchObject({
      storage: "remote_parquet",
      counts_cover: "reference_window",
      events: null,
      lines_read: null,
      patterns: null,
      single_event_patterns: null,
      capabilities: {
        patterns: false,
        investigation_order: false,
        full_text: "reference_window",
        direct_scan: { max_seconds: 60, max_files: 2 },
        context_scopes: ["same_trace", "same_component", "dataset"],
      },
      remote: {
        footer_rows: naive,
        reference_window: {
          ...REFERENCE,
          index: "otel_ref_idx",
          events: distinct,
          // The fixtures share exactly one boundary row.
          duplicates_removed: naive - distinct,
        },
      },
    })
    expect(naive - distinct).toBe(1)
  })
})

describe("otel bounded direct scan", () => {
  it("counts a boundary-crossing window once per row, with per-file half-open bounds", async () => {
    const result = await ok("count_events", {
      dataset: "otel",
      group_by: ["level"],
      ...CROSSING,
    })
    const expected = await scalar(
      `SELECT ${halfOpen("2025-09-23 00:29:24.039+00", "2025-09-23 00:29:24.0391+00")} AS n`
    )
    const both = await scalar(
      `SELECT count(*) AS n FROM read_parquet(['${PART_0}', '${PART_1}']) WHERE "Timestamp" >= '2025-09-23 00:29:24.039+00'::TIMESTAMPTZ_NS AND "Timestamp" < '2025-09-23 00:29:24.0391+00'::TIMESTAMPTZ_NS`
    )
    expect((result.data as { total: number }).total).toBe(expected)
    // Reading both files naively counts the shared boundary row twice.
    expect(both).toBe(expected + 1)
    const source = result.receipt.source
    if (source?.kind !== "remote_parquet") throw new Error("no remote source")
    expect(source).toMatchObject({
      dataset: "otel",
      path: "direct_scan",
      window: CROSSING,
      mapping_version: "1.0.0",
      index: null,
      bytes_read: { kind: "not_measured" },
      bytes_estimated_from_footer: { kind: "estimate" },
      source_check: { files_checked: 2 },
    })
    expect(source.files.map((file) => [file.file_index, file.url])).toEqual([
      [0, PART_0],
      [1, PART_1],
    ])
    expect(source.files[0]?.read_to).toBe("2025-09-23T00:29:24.039037200Z")
    expect(source.files[1]?.read_from).toBe("2025-09-23T00:29:24.039037200Z")
    // The stored receipt carries the same source block.
    const stored = await receipts.get(result.receipt.receipt_id)
    expect(stored?.source).toEqual(source)
  })

  it("filters only_errors and components with the catalog error levels", async () => {
    const result = await ok("count_events", {
      dataset: "otel",
      group_by: ["component"],
      only_errors: true,
      ...REFERENCE,
    })
    const expected = await scalar(
      `SELECT ${halfOpen("2025-09-23 00:29:24.037+00", "2025-09-23 00:29:24.041+00", `"SeverityText" IN ('error', 'fatal')`)} AS n`
    )
    expect((result.data as { total: number }).total).toBe(expected)
    expect(expected).toBeGreaterThan(0)
  })

  it("buckets an event_trend by second with the same total as count_events", async () => {
    const trend = await ok("event_trend", {
      dataset: "otel",
      bucket: "second",
      from: "2025-09-23T00:29:24Z",
      to: "2025-09-23T00:29:25Z",
      split_by: "level",
    })
    const counted = await ok("count_events", {
      dataset: "otel",
      group_by: ["level"],
      from: "2025-09-23T00:29:24Z",
      to: "2025-09-23T00:29:25Z",
    })
    const data = trend.data as {
      total: number
      buckets: { events: number; partial: boolean }[]
    }
    expect(data.total).toBe((counted.data as { total: number }).total)
    expect(data.buckets).toHaveLength(1)
    expect(data.buckets[0]?.events).toBe(data.total)
    expect(trend.receipt.source).toMatchObject({ path: "direct_scan" })
  })

  it("rejects a missing window, more than 60 s and a window outside the span with hints", async () => {
    expect(
      await failure("count_events", { dataset: "otel", group_by: ["level"] })
    ).toMatchObject({ code: "invalid_input" })
    const tooLong = await failure("event_trend", {
      dataset: "otel",
      bucket: "second",
      from: "2025-09-23T00:29:00Z",
      to: "2025-09-23T00:30:01Z",
    })
    expect(tooLong).toMatchObject({
      code: "limit_exceeded",
      limit: 60,
      requested: 61,
    })
    expect(tooLong.hint).toContain("at most 60 s")
    const outside = await failure("count_events", {
      dataset: "otel",
      group_by: ["level"],
      from: "2025-09-24T00:00:00Z",
      to: "2025-09-24T00:00:30Z",
    })
    expect(outside).toMatchObject({ code: "invalid_input" })
    expect(outside.message).toContain("outside the otel data span")
  })
})

describe("otel indexed reference window", () => {
  it("counts the same matches as the hits filter, equal to a regex over the files", async () => {
    const search = await ok("search_logs", {
      dataset: "otel",
      query: "called",
      limit: 5,
    })
    const counted = await ok("count_events", {
      dataset: "otel",
      group_by: ["component"],
      text: "called",
    })
    const expected = await scalar(
      `SELECT ${halfOpen("2025-09-23 00:29:24.037+00", "2025-09-23 00:29:24.041+00", word("called"))} AS n`
    )
    const data = search.data as {
      total_matches: number
      hits: { event_id: number; dataset: string; message: string }[]
    }
    expect(data.total_matches).toBe(expected)
    expect((counted.data as { total: number }).total).toBe(expected)
    expect(search.receipt.source).toMatchObject({
      path: "indexed_window",
      window: REFERENCE,
      index: { name: "otel_ref_idx", ...REFERENCE },
      bytes_estimated_from_footer: null,
    })
    // event_id = 10^12 + file index · 10^10 + file_row_number of that file.
    for (const hit of data.hits) {
      const file = Math.floor((hit.event_id - 1e12) / 1e10)
      const row = (hit.event_id - 1e12) % 1e10
      const { rows } = await oracle.query<{ body: string }>(
        `SELECT left("Body", 400) AS body FROM read_parquet('/data/raw/otel/part_00${file}.parquet', file_row_number = true) WHERE file_row_number = ${row}`
      )
      expect(rows[0]?.body).toBe(hit.message)
      expect(hit.dataset).toBe("otel")
    }
  })

  it("splits a text count by component exactly like a regex over the files", async () => {
    const counted = await ok("count_events", {
      dataset: "otel",
      group_by: ["component"],
      text: "called",
    })
    const { rows } = await oracle.query<{ component: string; n: string }>(
      `SELECT "ServiceName" AS component, count(*)::VARCHAR AS n FROM read_parquet('/data/raw/otel/part_00[0-1].parquet', filename = true)
       WHERE ${word("called")} AND (filename = '${PART_0}' AND "Timestamp" < '${BOUNDARY}'::TIMESTAMPTZ_NS OR filename = '${PART_1}')
       GROUP BY 1 ORDER BY count(*) DESC, 1`
    )
    expect(
      (
        counted.data as { groups: { component: string; events: number }[] }
      ).groups.map((group) => [group.component, group.events])
    ).toEqual(rows.map((row) => [row.component, Number(row.n)]))
  })

  it("rejects full text outside the reference window and every pattern function", async () => {
    const outside = await failure("search_logs", {
      dataset: "otel",
      query: "called",
      from: "2025-09-23T00:29:00Z",
    })
    expect(outside).toMatchObject({ code: "invalid_input" })
    expect(outside.hint).toContain(REFERENCE.from)
    for (const [tool, input] of [
      ["recurring_patterns", { dataset: "otel" }],
      ["get_log_context", { mode: "aggregate", dataset: "otel", query: "x" }],
      [
        "event_trend",
        {
          dataset: "otel",
          bucket: "second",
          split_by: "pattern",
          ...CROSSING,
        },
      ],
      ["latency_stats", { dataset: "otel" }],
    ] as const)
      expect(await failure(tool, input)).toMatchObject({
        code: "invalid_input",
      })
  })

  it("leaves otel out of a scope without dataset and says so", async () => {
    const result = await ok("count_events", { group_by: ["dataset"] })
    const groups = (result.data as { groups: { dataset: string }[] }).groups
    expect(groups.map((group) => group.dataset)).toEqual(["bgl", "openstack"])
    expect(result.notes.join(" ")).toContain("otel is loaded but not included")
  })
})

describe("otel get_log_context", () => {
  it("returns the records of the same trace around an anchor from search_logs", async () => {
    const { rows } = await oracle.query<{ trace: string; n: string }>(
      `SELECT "TraceId" AS trace, count(*) AS n FROM read_parquet('/data/raw/otel/part_00[0-1].parquet') WHERE "TraceId" <> '' GROUP BY 1 HAVING count(*) = 2 ORDER BY 1 LIMIT 1`
    )
    const trace = rows[0]?.trace
    if (trace === undefined) throw new Error("no trace with two records")
    const anchorRow = await oracle.query<{ file: string; row: string }>(
      `SELECT regexp_extract(filename, 'part_([0-9]{3})', 1) AS file, file_row_number::VARCHAR AS row FROM read_parquet('/data/raw/otel/part_00[0-1].parquet', filename = true, file_row_number = true) WHERE "TraceId" = '${trace}' ORDER BY "Timestamp", filename, file_row_number LIMIT 1`
    )
    const first = anchorRow.rows[0]
    if (first === undefined) throw new Error("no anchor")
    const eventId = 1e12 + Number(first.file) * 1e10 + Number(first.row)
    const context = await ok("get_log_context", {
      mode: "event",
      event_id: eventId,
      scope: "same_trace",
    })
    const data = context.data as {
      anchor: { trace_id: string; dataset: string }
      scope_value: string
      sides: { direction: string; in_window: number }[]
      events_after: { trace_id: string; offset_ms: number }[]
    }
    expect(data.anchor).toMatchObject({ trace_id: trace, dataset: "otel" })
    expect(data.scope_value).toBe(trace)
    expect(data.sides.map((side) => side.in_window)).toEqual([0, 1])
    expect(data.events_after[0]?.trace_id).toBe(trace)
    expect(data.events_after[0]?.offset_ms).toBeGreaterThanOrEqual(0)
    expect(context.receipt.source).toMatchObject({ path: "indexed_window" })
    expect(context.receipt.scope.windows[0]).toEqual({
      dataset: "otel",
      ...REFERENCE,
    })
  })

  it("rejects same_trace for a record without trace and an ID outside the reference window", async () => {
    const { rows } = await oracle.query<{ row: string }>(
      `SELECT file_row_number::VARCHAR AS row FROM read_parquet('${PART_0}', file_row_number = true) WHERE "TraceId" = '' ORDER BY file_row_number LIMIT 1`
    )
    const eventId = 1e12 + Number(rows[0]?.row)
    expect(
      await failure("get_log_context", {
        mode: "event",
        event_id: eventId,
        scope: "same_trace",
      })
    ).toMatchObject({ code: "invalid_input", issues: [{ path: "scope" }] })
    const missing = await failure("get_log_context", {
      mode: "event",
      event_id: 1e12 + 2e10 + 5,
    })
    expect(missing).toMatchObject({ code: "not_found" })
    expect(missing.hint).toContain("indexed reference window")
  })
})

describe("otel source check", () => {
  const CHECK_DB = "log_insights_otel_check"
  const copyDir = join(hostRawDir(), "otel-check")
  const copy = join(copyDir, "part_000.parquet")
  const containerCopy = "/data/raw/otel-check/part_000.parquet"
  let check: Database
  let checkRegistry: Registry

  beforeAll(async () => {
    await mkdir(copyDir, { recursive: true })
    await copyFile(join(hostRawDir(), "otel", "part_000.parquet"), copy)
    // A minimal otel load over the copy: the tables the tools read, built
    // like the loader's (60_otel_sources.sql), pinned to the copy as it is.
    await rebuildDatabase({ ...otelSamplesConnection(), database: CHECK_DB }, [
      "CREATE OR REPLACE TABLE load_manifest AS SELECT 'dv_otel_check' AS data_version",
      `CREATE OR REPLACE TABLE corpus_stats AS SELECT 'otel' AS dataset, make_timestamptz(epoch_ns(min("Timestamp")) // 1000) AS first_ts, make_timestamptz(epoch_ns(max("Timestamp")) // 1000) AS last_ts FROM read_parquet('${containerCopy}')`,
      `CREATE OR REPLACE TABLE otel_sources AS SELECT 0 AS file_index, b.filename AS url, b.size, NULL::VARCHAR AS etag, b.last_modified, m.ts_min AS assigned_from, NULL::TIMESTAMPTZ_NS AS assigned_to FROM read_blob('${containerCopy}') b, (SELECT min("Timestamp") AS ts_min FROM read_parquet('${containerCopy}')) m`,
      `CREATE OR REPLACE TABLE otel_row_groups AS SELECT 0 AS file_index, 0 AS row_group_id, min("Timestamp") AS ts_min, max("Timestamp") AS ts_max, 1::BIGINT AS compressed_bytes FROM read_parquet('${containerCopy}')`,
      "CREATE OR REPLACE TABLE otel_reference AS SELECT '1.0.0' AS mapping_version",
    ])
    check = createDatabase({ ...otelSamplesConnection(), database: CHECK_DB })
    checkRegistry = createRegistry({
      db: check,
      receipts: new FileReceiptStore(dir),
      log: () => undefined,
    })
  })

  afterAll(async () => {
    await check.dispose()
    await rm(copyDir, { recursive: true, force: true })
  })

  it("answers while the file matches its pin and fails with source_changed after it changes", async () => {
    const input = {
      dataset: "otel",
      group_by: ["level"],
      from: "2025-09-23T00:29:24.037000Z",
      to: "2025-09-23T00:29:24.039000Z",
    }
    const before = await checkRegistry.runTool("count_events", input, call())
    expect(before.ok).toBe(true)
    // A new modification time is a changed source (size and Last-Modified).
    const later = new Date(Date.now() + 60_000)
    await utimes(copy, later, later)
    // Docker Desktop's file sharing caches file attributes for a moment
    // (observed: the old mtime for up to about a second), so poll briefly;
    // on Linux bind mounts the change is visible at once.
    let outcome = await checkRegistry.runTool("count_events", input, call())
    for (let attempt = 0; outcome.ok && attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      outcome = await checkRegistry.runTool("count_events", input, call())
    }
    if (outcome.ok) throw new Error("the changed source was never noticed")
    const error = outcome.error
    expect(error).toMatchObject({
      code: "source_changed",
      files: [containerCopy],
    })
    expect(error.hint).toContain("pnpm data:setup --with otel")
  })
})
