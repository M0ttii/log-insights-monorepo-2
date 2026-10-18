/**
 * Independent, synthetic receipt fixtures for SereneDB's native aggregates.
 * The main group has sorted durations 1, 3, 7, 9 ms: median 5 ms and the
 * continuous p95 8.7 ms (h = 2.85, between 7 and 9). A half-open microsecond
 * window selects 3 and 7 ms: median 5 ms, p95 6.8 ms. These expectations are
 * worked out here, rather than imported from the report implementation.
 *
 * Files are published exclusively into the configured Compose receipt mount;
 * a separate host snapshot selects only this suite's random receipt IDs. No
 * corpus, schema, or existing receipt is modified.
 */
import { createHash, randomBytes } from "node:crypto"
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"

import { receiptSchema, type Receipt } from "@workspace/domain/receipt"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../../src/config.ts"
import { createDatabase } from "../../src/db.ts"
import { runPerformanceReport } from "../../src/performance.ts"
import { receiptSignature, resultDigest } from "../../src/receipts.ts"
import { loadEnv, temporaryDir } from "./helpers.ts"

loadEnv()

const config = loadConfig()
const db = createDatabase(config.connection)
const published: string[] = []
const temporary: string[] = []
const FIRST = "2026-10-18T12:00:00.000001Z"
const SECOND = "2026-10-18T12:00:00.000002Z"
const THIRD = "2026-10-18T12:00:00.000003Z"
const LAST = "2026-10-18T12:00:00.000004Z"
let selection: string
let main: Receipt

function fixture(overrides: Partial<Receipt> = {}): Receipt {
  const tool = overrides.tool ?? "count_events"
  const version = overrides.tool_version ?? "1.0.0"
  return receiptSchema.parse({
    receipt_id: `r_${randomBytes(4).toString("hex")}`,
    created_at: FIRST,
    client: "test",
    tool,
    tool_version: version,
    input: {},
    signature: receiptSignature(tool, version, {}),
    data_version: "dv_performance_a",
    sql: [],
    params: [],
    scope: { windows: [], filters: {} },
    population: null,
    rows_returned: 0,
    truncated: false,
    row_limit: null,
    duration_ms: 1,
    result: {},
    result_digest: resultDigest({}),
    facts: [],
    ...overrides,
  })
}

beforeAll(async () => {
  selection = await temporaryDir("analytics-performance-selection-")
  temporary.push(selection)
  await mkdir(config.receiptsDir, { recursive: true })
  main = fixture()
  const fixtures = [
    main,
    fixture({ created_at: SECOND, duration_ms: 3 }),
    fixture({ created_at: THIRD, duration_ms: 7 }),
    fixture({ created_at: LAST, duration_ms: 9 }),
    fixture({ data_version: "dv_performance_b", duration_ms: 111 }),
    fixture({ tool: "search_logs", duration_ms: 222 }),
    fixture({ tool_version: "2.0.0", duration_ms: 333 }),
    fixture({ client: "mcp", duration_ms: 444 }),
  ]
  for (const receipt of fixtures) {
    const filename = `${receipt.receipt_id}.json`
    const mountedFile = join(config.receiptsDir, filename)
    // wx protects another suite or process even in the unlikely ID collision.
    await writeFile(mountedFile, JSON.stringify(receipt), { flag: "wx" })
    published.push(mountedFile)
    await copyFile(mountedFile, join(selection, filename))
  }
})

afterAll(async () => {
  await db.dispose()
  await Promise.all(published.map((file) => unlink(file)))
  await Promise.all(
    temporary.map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe("SereneDB: receipt performance report", () => {
  it("computes native quantiles and keeps every grouping dimension separate", async () => {
    const report = await runPerformanceReport(db, {
      receipts_dir: selection,
    })
    expect(report).toMatchObject({
      status: "measured",
      reason: null,
      n: 8,
      date_window: { first_created_at: FIRST, last_created_at: LAST },
    })
    expect(report.groups).toHaveLength(5)
    const primary = report.groups.find(
      (group) =>
        group.data_version === "dv_performance_a" &&
        group.tool === "count_events" &&
        group.tool_version === "1.0.0" &&
        group.client === "test"
    )
    expect(primary).toMatchObject({
      n: 4,
      median_ms: 5,
      min_ms: 1,
      max_ms: 9,
      date_window: { first_created_at: FIRST, last_created_at: LAST },
    })
    expect(primary?.p95_ms).toBeCloseTo(8.7, 12)
    expect(
      report.groups
        .filter((group) => group !== primary)
        .map((group) => [
          group.data_version,
          group.tool,
          group.tool_version,
          group.client,
          group.n,
          group.median_ms,
          group.p95_ms,
          group.min_ms,
          group.max_ms,
        ])
    ).toEqual([
      [
        "dv_performance_a",
        "count_events",
        "1.0.0",
        "mcp",
        1,
        444,
        444,
        444,
        444,
      ],
      [
        "dv_performance_a",
        "count_events",
        "2.0.0",
        "test",
        1,
        333,
        333,
        333,
        333,
      ],
      [
        "dv_performance_a",
        "search_logs",
        "1.0.0",
        "test",
        1,
        222,
        222,
        222,
        222,
      ],
      [
        "dv_performance_b",
        "count_events",
        "1.0.0",
        "test",
        1,
        111,
        111,
        111,
        111,
      ],
    ])
    expect(report.sources).toHaveLength(8)
    const bytes = await readFile(join(selection, `${main.receipt_id}.json`))
    expect(
      report.sources.find((source) => source.receipt_id === main.receipt_id)
    ).toMatchObject({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      signature: main.signature,
      result_digest: main.result_digest,
    })
    expect(report.queries).toHaveLength(1)
  })

  it("includes from, excludes to, and preserves microseconds", async () => {
    const report = await runPerformanceReport(db, {
      receipts_dir: selection,
      from: SECOND,
      to: LAST,
    })
    expect(report).toMatchObject({
      status: "measured",
      n: 2,
      date_window: { first_created_at: SECOND, last_created_at: THIRD },
    })
    expect(report.groups).toHaveLength(1)
    expect(report.groups[0]).toMatchObject({
      n: 2,
      median_ms: 5,
      min_ms: 3,
      max_ms: 7,
      date_window: { first_created_at: SECOND, last_created_at: THIRD },
    })
    expect(report.groups[0]?.p95_ms).toBeCloseTo(6.8, 12)
  })

  it("returns an SQL-counted empty window without invented percentiles", async () => {
    const report = await runPerformanceReport(db, {
      receipts_dir: selection,
      from: "2026-10-19T00:00:00Z",
    })
    expect(report).toMatchObject({
      status: "not_measured",
      reason: "no_receipts_in_window",
      n: 0,
      date_window: null,
      groups: [],
    })
    expect(report.sources).toHaveLength(8)
    expect(report.queries).toHaveLength(1)
  })

  it("rejects a host snapshot whose duration differs from its mounted source", async () => {
    const altered = await temporaryDir("analytics-performance-altered-")
    temporary.push(altered)
    await writeFile(
      join(altered, `${main.receipt_id}.json`),
      JSON.stringify({ ...main, duration_ms: 999 })
    )
    await expect(
      runPerformanceReport(db, { receipts_dir: altered })
    ).rejects.toThrow("Database source does not match local snapshot")
  })
})
