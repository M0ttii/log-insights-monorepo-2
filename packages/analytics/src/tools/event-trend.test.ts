import type { Receipt } from "@workspace/domain/receipt"
import { describe, expect, it } from "vitest"

import { createRegistry } from "../registry.ts"

/**
 * event_trend against a fake database: the SQL it sends, the order of its
 * queries, early exits and the text summary. Behaviour against SereneDB is
 * covered by tests/integration/event-trend.test.ts.
 */

const SPAN = {
  first: "2005-06-03T22:42:50.675872Z",
  last: "2005-06-05T10:00:00.000000Z",
}

type Call = { sql: string; params: readonly unknown[] }

function setup(
  answers: {
    buckets?: Record<string, unknown>[]
    series?: Record<string, unknown>[]
    cells?: Record<string, unknown>[]
    covered?: string[]
    span?: { first: string; last: string }
  } = {}
) {
  const calls: Call[] = []
  const stored: Receipt[] = []
  const db = {
    timeoutMs: 10_000,
    async query(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params })
      const rows = ((): Record<string, unknown>[] => {
        if (sql === "SELECT data_version FROM load_manifest")
          return [{ data_version: "dv_test" }]
        if (sql.includes("FROM corpus_stats")) return [answers.span ?? SPAN]
        if (sql.includes("slot, value")) return answers.series ?? []
        if (sql.includes("bucket_events")) return answers.cells ?? []
        if (sql.includes("sum(c.events) OVER ()")) return answers.buckets ?? []
        if (sql.startsWith("SELECT strftime(c.bucket"))
          return (answers.covered ?? []).map((bucket) => ({ bucket }))
        throw new Error(`unexpected SQL: ${sql}`)
      })()
      return { rows, durationMs: 1 }
    },
  }
  const registry = createRegistry({
    db,
    receipts: {
      put: async (receipt) => {
        stored.push(receipt)
      },
      get: async () => null,
      list: async () => [],
    },
    log: () => undefined,
  })
  const trend = (input: unknown) =>
    registry.runTool("event_trend", input, {
      client: "test",
      signal: new AbortController().signal,
    })
  const entry = registry.tools.find((tool) => tool.name === "event_trend")
  if (entry === undefined) throw new Error("event_trend not registered")
  return { calls, stored, trend, entry }
}

const toolCalls = (calls: Call[]) =>
  calls.filter((call) => !call.sql.includes("load_manifest"))

const DAY_3 = "2005-06-03T00:00:00.000000Z"
const DAY_4 = "2005-06-04T00:00:00.000000Z"
const DAY_5 = "2005-06-05T00:00:00.000000Z"

describe("event_trend SQL", () => {
  it("reads the span, the captured buckets and the counts with the effective range", async () => {
    const { calls, trend } = setup({
      buckets: [
        { bucket: DAY_3, events: "4", total: "9" },
        { bucket: DAY_5, events: "5", total: "9" },
      ],
      covered: [DAY_3, DAY_5],
    })
    const outcome = await trend({
      dataset: "bgl",
      bucket: "day",
      from: "2005-06-01T00:00:00Z",
      levels: ["FATAL"],
    })
    if (!outcome.ok) throw new Error(outcome.error.message)
    const [span, covered, counted] = toolCalls(calls)
    expect(span?.params).toEqual(["bgl"])
    expect(covered).toEqual({
      sql: "SELECT strftime(c.bucket, '%Y-%m-%dT%H:%M:%S.%fZ') AS bucket FROM (SELECT date_trunc('day', log_events.ts) AS bucket FROM log_events WHERE log_events.dataset = $1 AND log_events.ts >= $2::TIMESTAMPTZ AND log_events.ts < $3::TIMESTAMPTZ GROUP BY 1) c ORDER BY c.bucket",
      params: ["bgl", SPAN.first, "2005-06-05T10:00:00.000001Z"],
    })
    expect(counted).toEqual({
      sql: "SELECT strftime(c.bucket, '%Y-%m-%dT%H:%M:%S.%fZ') AS bucket, c.events, sum(c.events) OVER () AS total FROM (SELECT date_trunc('day', log_events.ts) AS bucket, count(*) AS events FROM log_events WHERE log_events.dataset = $1 AND log_events.ts >= $2::TIMESTAMPTZ AND log_events.ts < $3::TIMESTAMPTZ AND log_events.level IN ($4) GROUP BY 1) c ORDER BY c.bucket",
      params: ["bgl", SPAN.first, "2005-06-05T10:00:00.000001Z", "FATAL"],
    })
    const data = outcome.result.data
    expect(data).toMatchObject({
      total: 9,
      bucket_count: 3,
      buckets: [
        { bucket_start: DAY_3, events: 4, partial: true, capture_gap: false },
        { bucket_start: DAY_4, events: 0, partial: false, capture_gap: true },
        { bucket_start: DAY_5, events: 5, partial: true, capture_gap: false },
      ],
    })
  })

  it("ranks series and cells from one CTE when split", async () => {
    const { calls, trend, entry } = setup({
      series: [
        {
          slot: "1",
          value: "KERNEL",
          events: "7",
          merged_values: "1",
          total: "9",
        },
        { slot: "6", value: null, events: "2", merged_values: "3", total: "9" },
      ],
      cells: [
        { bucket: DAY_3, slot: "1", events: "4", bucket_events: "6" },
        { bucket: DAY_3, slot: "6", events: "2", bucket_events: "6" },
        { bucket: DAY_5, slot: "1", events: "3", bucket_events: "3" },
      ],
      covered: [DAY_3, DAY_4, DAY_5],
    })
    const outcome = await trend({
      dataset: "bgl",
      bucket: "day",
      split_by: "component",
    })
    if (!outcome.ok) throw new Error(outcome.error.message)
    const [, , series, cells] = toolCalls(calls)
    const cte =
      "WITH cells AS (SELECT date_trunc('day', log_events.ts) AS bucket, log_events.component AS value, count(*) AS events FROM log_events WHERE log_events.dataset = $1 AND log_events.ts >= $2::TIMESTAMPTZ AND log_events.ts < $3::TIMESTAMPTZ GROUP BY 1, 2), ranked AS (SELECT bucket, value, events, dense_rank() OVER (ORDER BY value_events DESC, value ASC NULLS LAST) AS series_rank FROM (SELECT bucket, value, events, sum(events) OVER (PARTITION BY value) AS value_events FROM cells) t), slots AS (SELECT bucket, least(series_rank, 6) AS slot, CASE WHEN series_rank <= 5 THEN value END AS value, series_rank, events FROM ranked)"
    expect(series?.sql).toBe(
      `${cte} SELECT slot, value, sum(events) AS events, count(DISTINCT series_rank) AS merged_values, sum(sum(events)) OVER () AS total FROM slots GROUP BY slot, value ORDER BY slot`
    )
    expect(cells?.sql).toBe(
      `${cte} SELECT strftime(bucket, '%Y-%m-%dT%H:%M:%S.%fZ') AS bucket, slot, sum(events) AS events, sum(sum(events)) OVER (PARTITION BY bucket) AS bucket_events FROM slots GROUP BY bucket, slot ORDER BY bucket, slot`
    )
    expect(cells?.params).toEqual(series?.params)

    const { data, facts } = outcome.result
    expect(data).toMatchObject({
      total: 9,
      series: [{ component: "KERNEL", events: 7 }],
      other: { events: 2, merged_values: 3 },
      buckets: [
        {
          events: 6,
          series: [{ component: "KERNEL", events: 4 }],
          other_events: 2,
        },
        {
          events: 0,
          series: [{ component: "KERNEL", events: 0 }],
          other_events: 0,
          capture_gap: false,
        },
        {
          events: 3,
          series: [{ component: "KERNEL", events: 3 }],
          other_events: 0,
        },
      ],
    })
    expect(
      facts.find((f) => f.path === "/result/buckets/2/series/0/events")
    ).toMatchObject({
      value: 3,
      group: { dataset: "bgl", bucket_start: DAY_5, component: "KERNEL" },
    })

    const text = entry.summarize(outcome.result)
    expect(text).toContain("event_trend bgl by day, split by component")
    expect(text).toContain('Series: "KERNEL" 7 [')
    expect(text).toContain("other (3 values) 2 [")
    expect(text).toMatch(
      /2005-06-03T00:00:00\.000000Z 6 \[r_[0-9a-f]{8}\.f\d+\] \("KERNEL" 4 \[r_[0-9a-f]{8}\.f\d+\], other 2 \[r_[0-9a-f]{8}\.f\d+\]\) \[partial\]/
    )
  })

  it("stops after the span when the window lies outside it", async () => {
    const { calls, stored, trend } = setup()
    const outcome = await trend({
      dataset: "bgl",
      bucket: "hour",
      from: "2006-01-01T00:00:00Z",
      to: "2006-01-02T00:00:00Z",
    })
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(toolCalls(calls)).toHaveLength(1)
    expect(outcome.result.data).toMatchObject({
      effective_range: null,
      total: null,
      buckets: [],
    })
    expect(stored[0]?.scope.windows).toEqual([
      {
        dataset: "bgl",
        from: "2006-01-01T00:00:00Z",
        to: "2006-01-02T00:00:00Z",
      },
    ])
  })

  it("fails with limit_exceeded before counting and stores no receipt", async () => {
    // 3 June 22:00 … 20 June 00:00: 2 + 16 × 24 + 1 hours, 18 days.
    const { calls, stored, trend } = setup({
      span: { first: SPAN.first, last: "2005-06-20T00:00:00.000000Z" },
    })
    const outcome = await trend({ dataset: "bgl", bucket: "hour" })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "limit_exceeded",
      limit: 120,
      requested: 387,
      hint: 'Use bucket "day" (18 buckets), or narrow from/to to at most 120 hours inside the data span.',
    })
    expect(toolCalls(calls)).toHaveLength(1)
    expect(stored).toHaveLength(0)
  })

  it("rejects BGL-only filters and dimensions for OpenStack before any query", async () => {
    const { calls, trend } = setup()
    const outcome = await trend({
      dataset: "openstack",
      bucket: "hour",
      rack: "R02",
      split_by: "alert_label",
    })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "rack" }, { path: "split_by" }],
    })
    expect(calls).toHaveLength(0)
  })
})
