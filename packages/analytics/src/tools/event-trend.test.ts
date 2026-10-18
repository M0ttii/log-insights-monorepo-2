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
    grid?: Record<string, unknown>[]
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
        if (sql.includes("AS capture_gap FROM grid"))
          return (
            answers.grid ??
            [
              { bucket: DAY_3, bucket_end: DAY_4, partial: true },
              { bucket: DAY_4, bucket_end: DAY_5, partial: false },
              {
                bucket: DAY_5,
                bucket_end: "2005-06-06T00:00:00.000000Z",
                partial: true,
              },
            ].map((slot) => ({
              ...slot,
              capture_gap: !(answers.covered ?? []).includes(slot.bucket),
            }))
          )
        if (sql.includes("slot, value")) return answers.series ?? []
        if (sql.includes("bucket_events")) return answers.cells ?? []
        if (sql.includes("LEFT JOIN counted c")) return answers.buckets ?? []
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
        { bucket: DAY_4, events: "0", total: "9" },
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
    expect(covered?.sql).toContain("unnest(range(")
    expect(covered?.sql).toContain(
      "LEFT JOIN captured c ON g.bucket = c.bucket"
    )
    expect(covered?.sql).toContain("c.bucket IS NULL AS capture_gap")
    expect(covered?.sql).toContain("strftime(g.bucket + $7::INTERVAL,")
    expect(covered?.params).toEqual([
      "bgl",
      SPAN.first,
      "2005-06-05T10:00:00.000001Z",
      SPAN.first,
      "2005-06-05T10:00:00.000001Z",
      "1 day",
      "1 day",
      SPAN.first,
      "1 day",
      "2005-06-05T10:00:00.000001Z",
    ])
    expect(counted?.sql).toContain("unnest(range(")
    expect(counted?.sql).toContain("LEFT JOIN counted c ON g.bucket = c.bucket")
    expect(counted?.sql).toContain("coalesce(c.events, 0)::BIGINT AS events")
    expect(counted?.sql).toContain("log_events.level IN ($4)")
    expect(counted?.sql).toContain("ORDER BY g.bucket")
    expect(counted?.params).toEqual([
      "bgl",
      SPAN.first,
      "2005-06-05T10:00:00.000001Z",
      "FATAL",
      SPAN.first,
      "2005-06-05T10:00:00.000001Z",
      "1 day",
    ])
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
        { bucket: DAY_4, slot: "1", events: "0", bucket_events: "0" },
        { bucket: DAY_4, slot: "6", events: "0", bucket_events: "0" },
        { bucket: DAY_5, slot: "1", events: "3", bucket_events: "3" },
        { bucket: DAY_5, slot: "6", events: "0", bucket_events: "3" },
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
    expect(series?.sql).toContain("unnest(range(")
    expect(series?.sql).toContain(
      "dense_rank() OVER (ORDER BY value_events DESC, value ASC NULLS LAST)"
    )
    expect(series?.sql).toContain("GROUP BY slot, value ORDER BY slot")
    expect(cells?.sql).toContain("LEFT JOIN named_slots n ON TRUE")
    expect(cells?.sql).toContain(
      "LEFT JOIN slot_totals c ON c.bucket = g.bucket AND c.slot = n.slot"
    )
    expect(cells?.sql).toContain("coalesce(c.events, 0)::BIGINT AS events")
    expect(cells?.sql).toContain("ORDER BY bucket, slot")
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

  it("preserves the SQL zero grid when no split series matches", async () => {
    const { stored, trend } = setup({
      cells: [DAY_3, DAY_4, DAY_5].map((bucket) => ({
        bucket,
        slot: null,
        events: "0",
        bucket_events: "0",
      })),
      covered: [DAY_3, DAY_5],
    })
    const outcome = await trend({
      dataset: "bgl",
      bucket: "day",
      split_by: "component",
      levels: ["UNKNOWN"],
    })
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(outcome.result.data).toMatchObject({
      total: 0,
      series: [],
      other: null,
      bucket_count: 3,
      buckets: [
        { events: 0, series: [], other_events: null, capture_gap: false },
        { events: 0, series: [], other_events: null, capture_gap: true },
        { events: 0, series: [], other_events: null, capture_gap: false },
      ],
    })
    expect(stored[0]?.population).toEqual({ count: 0, unit: "log_events" })
    expect(outcome.result.notes).toContain(
      "No log event matches the filters in the effective range; every bucket is a zero."
    )
    expect(
      outcome.result.facts.find(
        (fact) => fact.path === "/result/buckets/1/events"
      )
    ).toMatchObject({
      value: 0,
      group: { dataset: "bgl", bucket_start: DAY_4 },
    })
  })

  it("fails when SQL omits a bucket instead of fabricating a zero", async () => {
    const { stored, trend } = setup({
      buckets: [
        { bucket: DAY_3, events: "4", total: "9" },
        { bucket: DAY_5, events: "5", total: "9" },
      ],
    })
    await expect(trend({ dataset: "bgl", bucket: "day" })).rejects.toThrow(
      "Tool event_trend failed unexpectedly"
    )
    expect(stored).toEqual([])
  })

  it("fails when SQL omits a split cell instead of fabricating a zero", async () => {
    const { stored, trend } = setup({
      series: [
        {
          slot: "1",
          value: "KERNEL",
          events: "4",
          merged_values: "1",
          total: "4",
        },
      ],
      cells: [
        { bucket: DAY_3, slot: "1", events: "4", bucket_events: "4" },
        { bucket: DAY_4, slot: null, events: "0", bucket_events: "0" },
        { bucket: DAY_5, slot: "1", events: "0", bucket_events: "0" },
      ],
    })
    await expect(
      trend({ dataset: "bgl", bucket: "day", split_by: "component" })
    ).rejects.toThrow("Tool event_trend failed unexpectedly")
    expect(stored).toEqual([])
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
