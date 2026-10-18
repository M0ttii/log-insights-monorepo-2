import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Receipt } from "@workspace/domain/receipt"
import type { QueryRunner } from "@workspace/domain/tool"
import { afterEach, describe, expect, it } from "vitest"

import { runPerformanceReport } from "./performance.ts"
import { receiptSignature, resultDigest } from "./receipts.ts"

const directories: string[] = []
const CREATED = "2026-10-18T12:00:00.000000Z"

function receipt(id: string, overrides: Partial<Receipt> = {}): Receipt {
  const tool = overrides.tool ?? "count_events"
  const version = overrides.tool_version ?? "1.0.0"
  return {
    receipt_id: id,
    created_at: CREATED,
    client: "test",
    tool,
    tool_version: version,
    input: {},
    signature: receiptSignature(tool, version, overrides.input ?? {}),
    data_version: "dv_test",
    sql: [],
    params: [],
    scope: { windows: [], filters: {} },
    population: null,
    rows_returned: 0,
    truncated: false,
    row_limit: null,
    duration_ms: 4,
    result: {},
    result_digest: resultDigest(overrides.result ?? {}),
    facts: [],
    ...overrides,
  }
}

async function setup(receipts: Receipt[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "log56-performance-"))
  directories.push(dir)
  for (const item of receipts)
    await writeFile(join(dir, `${item.receipt_id}.json`), JSON.stringify(item))
  return dir
}

function row(item: Receipt, overrides: Record<string, unknown> = {}) {
  return {
    n: "1",
    group_count: "1",
    first_created_at: CREATED,
    last_created_at: CREATED,
    receipt_id: item.receipt_id,
    source_created_at: item.created_at,
    signature: item.signature,
    result_digest: item.result_digest,
    duration_ms: item.duration_ms,
    data_version: item.data_version,
    tool: item.tool,
    tool_version: item.tool_version,
    client: item.client,
    group_n: "1",
    median_ms: 4,
    p95_ms: 4,
    min_ms: 4,
    max_ms: 4,
    group_first_created_at: CREATED,
    group_last_created_at: CREATED,
    ...overrides,
  }
}

function database(rows: Record<string, unknown>[]) {
  const calls: {
    sql: string
    params: readonly unknown[]
    signal: AbortSignal
  }[] = []
  const db: QueryRunner = {
    async query(sql, params, signal) {
      calls.push({ sql, params, signal })
      return { rows, durationMs: 1 }
    },
  }
  return { db, calls }
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => rm(dir, { recursive: true }))
  )
})

describe("receipt database performance report", () => {
  it.each(["signature", "result_digest"])(
    "rejects a corrupt %s before SQL",
    async (field) => {
      const dir = await setup([
        receipt("r_00000001", { [field]: "0".repeat(64) }),
      ])
      const { db, calls } = database([])
      await expect(
        runPerformanceReport(db, { receipts_dir: dir })
      ).rejects.toThrow("Invalid receipt r_00000001.json")
      expect(calls).toHaveLength(0)
    }
  )
  it("binds receipt IDs and half-open window, retains SQL values and immutable sources", async () => {
    const item = receipt("r_00000001")
    const dir = await setup([item])
    const { db, calls } = database([
      row(item, { median_ms: 3.25, p95_ms: 3.9 }),
    ])
    const signal = new AbortController().signal
    const report = await runPerformanceReport(
      db,
      {
        receipts_dir: dir,
        database_receipts_dir: "/data/receipts",
        from: "2026-10-18T00:00:00Z",
        to: "2026-10-19T00:00:00Z",
      },
      signal
    )
    expect(report.status).toBe("measured")
    expect(report.n).toBe(1)
    expect(report.groups[0]).toMatchObject({
      n: 1,
      median_ms: 3.25,
      p95_ms: 3.9,
    })
    expect(report.sources).toEqual([
      expect.objectContaining({
        receipt_id: item.receipt_id,
        filename: `${item.receipt_id}.json`,
        signature: item.signature,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.params).toEqual([
      ["r_00000001"],
      "2026-10-18T00:00:00Z",
      "2026-10-19T00:00:00Z",
    ])
    expect(calls[0]?.sql).toContain("WHERE receipt_id = ANY($1::VARCHAR[])")
    expect(calls[0]?.sql).toContain("quantile_cont(duration_ms, 0.95)")
    expect(calls[0]?.sql).toContain("created_at >= $2::TIMESTAMPTZ")
    expect(calls[0]?.sql).toContain("created_at < $3::TIMESTAMPTZ")
    expect(calls[0]?.sql).not.toContain("quoted")
    expect(calls[0]?.sql).toContain(
      "ORDER BY data_version, tool, tool_version, client, receipt_id"
    )
    expect(calls[0]?.signal).toBe(signal)
    expect(report.queries).toEqual([
      { sql: calls[0]?.sql, params: calls[0]?.params },
    ])
    expect(JSON.stringify(report)).not.toContain('"result":')
  })

  it("rejects arbitrary server paths rather than interpolating SQL values", async () => {
    const dir = await setup([receipt("r_00000001")])
    const { db, calls } = database([])
    await expect(
      runPerformanceReport(db, {
        receipts_dir: dir,
        database_receipts_dir: "/data/receipts'quoted",
      })
    ).rejects.toThrow(/Invalid input/)
    expect(calls).toHaveLength(0)
  })

  it("keeps versions and clients separate rather than pooling their numbers", async () => {
    const a = receipt("r_00000001")
    const b = receipt("r_00000002", {
      data_version: "dv_other",
      client: "eval",
      tool_version: "2.0.0",
    })
    const dir = await setup([a, b])
    const { db } = database([
      row(a, { n: "2", group_count: "2" }),
      row(b, { n: "2", group_count: "2" }),
    ])
    const report = await runPerformanceReport(db, { receipts_dir: dir })
    expect(report.groups).toHaveLength(2)
    expect(
      report.groups.map((group) => [
        group.data_version,
        group.tool_version,
        group.client,
      ])
    ).toEqual([
      ["dv_test", "1.0.0", "test"],
      ["dv_other", "2.0.0", "eval"],
    ])
  })

  it("does not present absent receipts as zero milliseconds", async () => {
    const dir = await setup()
    const { db, calls } = database([])
    const report = await runPerformanceReport(db, { receipts_dir: dir })
    expect(report).toMatchObject({
      status: "not_measured",
      reason: "no_source_receipts",
      n: null,
      groups: [],
      date_window: null,
    })
    expect(calls).toHaveLength(0)
  })

  it("retains a SQL-counted empty window without inventing aggregate values", async () => {
    const item = receipt("r_00000001")
    const dir = await setup([item])
    const empty = Object.fromEntries(
      Object.keys(row(item)).map((key) => [key, null])
    )
    const { db } = database([{ ...empty, n: "0", group_count: "0" }])
    const report = await runPerformanceReport(db, {
      receipts_dir: dir,
      from: "2026-10-19T00:00:00Z",
    })
    expect(report).toMatchObject({
      status: "not_measured",
      reason: "no_receipts_in_window",
      n: 0,
      groups: [],
      date_window: null,
    })
  })

  it.each([undefined, null, -1, Infinity, "4"])(
    "rejects invalid duration %s before SQL",
    async (duration) => {
      const dir = await setup([receipt("r_00000001")])
      const text = JSON.stringify({
        ...receipt("r_00000001"),
        duration_ms: duration,
      })
      await writeFile(
        join(dir, "r_00000001.json"),
        duration === Infinity
          ? text.replace('"duration_ms":null', '"duration_ms":1e999')
          : text
      )
      const { db, calls } = database([])
      await expect(
        runPerformanceReport(db, { receipts_dir: dir })
      ).rejects.toThrow("Invalid receipt r_00000001.json")
      expect(calls).toHaveLength(0)
    }
  )

  it("rejects invalid JSON without leaking source text", async () => {
    const dir = await setup()
    await writeFile(
      join(dir, "r_00000001.json"),
      "private-log-text invalid json"
    )
    await expect(
      runPerformanceReport(database([]).db, { receipts_dir: dir })
    ).rejects.toThrow(/^Invalid receipt r_00000001.json$/)
  })

  it("rejects duplicate or mismatched database sources", async () => {
    const item = receipt("r_00000001")
    const dir = await setup([item])
    await expect(
      runPerformanceReport(database([row(item, { duration_ms: 999 })]).db, {
        receipts_dir: dir,
      })
    ).rejects.toThrow("Database source does not match")
    await expect(
      runPerformanceReport(database([row(item), row(item)]).db, {
        receipts_dir: dir,
      })
    ).rejects.toThrow("Duplicate database receipt")
  })

  it("rejects a source changed while SereneDB was reading it", async () => {
    const item = receipt("r_00000001")
    const dir = await setup([item])
    const db: QueryRunner = {
      async query() {
        const file = join(dir, "r_00000001.json")
        await writeFile(file, `${await readFile(file, "utf8")}\n`)
        return { rows: [row(item)], durationMs: 1 }
      },
    }
    await expect(
      runPerformanceReport(db, { receipts_dir: dir })
    ).rejects.toThrow("Receipt changed during report")
  })

  it("bounds source reads before and after SQL even if a file grows", async () => {
    const item = receipt("r_00000001")
    const dir = await setup([item])
    const file = join(dir, "r_00000001.json")
    const oversized = " ".repeat(4 * 1024 * 1024 + 1)
    const db: QueryRunner = {
      async query() {
        await writeFile(file, oversized)
        return { rows: [row(item)], durationMs: 1 }
      },
    }
    await expect(
      runPerformanceReport(db, { receipts_dir: dir })
    ).rejects.toThrow("Receipt changed during report")
    const untouched = database([])
    await expect(
      runPerformanceReport(untouched.db, { receipts_dir: dir })
    ).rejects.toThrow("Invalid receipt r_00000001.json")
    expect(untouched.calls).toHaveLength(0)
  })

  it("fails explicitly at source and group bounds", async () => {
    const a = receipt("r_00000001")
    const b = receipt("r_00000002")
    const dir = await setup([a, b])
    const { db, calls } = database([row(a, { group_count: "2" })])
    await expect(
      runPerformanceReport(db, { receipts_dir: dir, max_receipts: 1 })
    ).rejects.toThrow("Receipt limit exceeded")
    expect(calls).toHaveLength(0)
    await expect(
      runPerformanceReport(db, { receipts_dir: dir, max_groups: 1 })
    ).rejects.toThrow("Group limit exceeded")
  })

  it("rejects missing database rows and invalid SQL aggregate results", async () => {
    const item = receipt("r_00000001")
    const dir = await setup([item])
    await expect(
      runPerformanceReport(database([]).db, { receipts_dir: dir })
    ).rejects.toThrow("Missing performance summary")
    await expect(
      runPerformanceReport(database([row(item, { p95_ms: null })]).db, {
        receipts_dir: dir,
      })
    ).rejects.toThrow(/Invalid input/)
  })
})
