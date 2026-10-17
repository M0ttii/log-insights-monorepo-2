/**
 * event_trend through the registry against SereneDB with the Loghub 2k
 * samples (`pnpm data:setup --samples`).
 *
 * Expected values were determined from the raw sample file BGL_2k.log, not
 * from the loader or the tool: a Python script split each line into its
 * fields, took the time as the Unix seconds plus the microseconds of the
 * text timestamp in UTC, and counted lines per UTC hour, day and Monday
 * week (alert label `-` = none, error levels FATAL, ERROR, SEVERE, FAILURE,
 * `parity` as a whole lower-cased word of the message).
 */
import { rm } from "node:fs/promises"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import { eventTrend } from "../../src/tools/event-trend.ts"
import {
  loadEnv,
  runScript,
  samplesConnection,
  temporaryDir,
} from "./helpers.ts"

loadEnv()

const BGL_FIRST = "2005-06-03T22:42:50.675872Z"
const BGL_LAST = "2006-01-03T15:13:09.127918Z"
const BGL_END = "2006-01-03T15:13:09.127919Z"

let db: Database
let dir: string
let registry: Registry

beforeAll(async () => {
  db = createDatabase(samplesConnection())
  dir = await temporaryDir("analytics-trend-")
  registry = createRegistry({
    db,
    receipts: new FileReceiptStore(dir),
    log: () => undefined,
  })
})

afterAll(async () => {
  await db.dispose()
  await rm(dir, { recursive: true, force: true })
})

const call = () => ({
  client: "test" as const,
  signal: new AbortController().signal,
})

async function run(input: Record<string, unknown>) {
  return registry.runTool("event_trend", input, call())
}

async function trend(input: Record<string, unknown>) {
  const outcome = await run(input)
  if (!outcome.ok) throw new Error(outcome.error.message)
  return {
    ...outcome.result,
    data: eventTrend.output.parse(outcome.result.data),
  }
}

/** `[hour or date, events, capture_gap]` per bucket. */
function cells(
  buckets: readonly {
    bucket_start: string
    events: number
    capture_gap: boolean
  }[],
  slice: [number, number]
) {
  return buckets.map((bucket) => [
    bucket.bucket_start.slice(...slice),
    bucket.events,
    bucket.capture_gap,
  ])
}

const hour = (h: number) => `${String(h).padStart(2, "0")}`

describe("buckets", () => {
  it("counts hourly buckets like an independent count; empty hours are observed zeros", async () => {
    // 14 June 2005: 150 lines in hours 00 (15), 07 (1), 14 (4), 16 (40), 17 (57), 18 (31), 21 (2).
    const observed: Record<number, number> = {
      0: 15,
      7: 1,
      14: 4,
      16: 40,
      17: 57,
      18: 31,
      21: 2,
    }
    const result = await trend({
      dataset: "bgl",
      bucket: "hour",
      from: "2005-06-14T00:00:00Z",
      to: "2005-06-15T00:00:00Z",
    })
    expect(result.data).toMatchObject({
      total: 150,
      bucket_count: 24,
      split_by: null,
      series: [],
      other: null,
      effective_range: {
        from: "2005-06-14T00:00:00.000000Z",
        to: "2005-06-15T00:00:00.000000Z",
      },
    })
    // Without other filters, an empty bucket is one in which the dataset logged nothing.
    expect(cells(result.data.buckets, [11, 13])).toEqual(
      Array.from({ length: 24 }, (_, h) => [
        hour(h),
        observed[h] ?? 0,
        observed[h] === undefined,
      ])
    )
    expect(result.data.buckets.every((b) => !b.partial)).toBe(true)
    expect(result.data.buckets[16]).toMatchObject({
      bucket_start: "2005-06-14T16:00:00.000000Z",
      bucket_end: "2005-06-14T17:00:00.000000Z",
      other_events: null,
    })
    expect(result.receipt.population).toEqual({
      count: 150,
      unit: "log_events",
    })
  })

  it("keeps filtered zeros apart from capture gaps", async () => {
    // Errors on 14 June: hours 00 (15), 16 (40), 17 (57), 18 (31). Hours 07, 14
    // and 21 have only non-error lines: observed zeros, not capture gaps.
    const result = await trend({
      dataset: "bgl",
      bucket: "hour",
      from: "2005-06-14T00:00:00Z",
      to: "2005-06-15T00:00:00Z",
      only_errors: true,
    })
    expect(result.data.total).toBe(143)
    const byHour = new Map(
      result.data.buckets.map((b) => [b.bucket_start.slice(11, 13), b])
    )
    expect(byHour.get("17")).toMatchObject({ events: 57, capture_gap: false })
    for (const h of ["07", "14", "21"])
      expect(byHour.get(h)).toMatchObject({ events: 0, capture_gap: false })
    expect(byHour.get("03")).toMatchObject({ events: 0, capture_gap: true })
  })

  it("counts days with a full-text filter on the index relation", async () => {
    // parity in June 2005: 3 June (4), 6 (8), 15 (14), 16 (2), 21 (1), 22 (1), 26 (1).
    const result = await trend({
      dataset: "bgl",
      bucket: "day",
      from: "2005-06-01T00:00:00Z",
      to: "2005-07-01T00:00:00Z",
      text: "parity",
    })
    expect(result.data.total).toBe(31)
    const nonZero = result.data.buckets
      .filter((b) => b.events > 0)
      .map((b) => [b.bucket_start.slice(0, 10), b.events])
    expect(nonZero).toEqual([
      ["2005-06-03", 4],
      ["2005-06-06", 8],
      ["2005-06-15", 14],
      ["2005-06-16", 2],
      ["2005-06-21", 1],
      ["2005-06-22", 1],
      ["2005-06-26", 1],
    ])
    // 3 June to 30 June: 28 days; 11, 17 and 29 June have no line at all.
    expect(result.data.bucket_count).toBe(28)
    expect(
      result.data.buckets
        .filter((b) => b.capture_gap)
        .map((b) => b.bucket_start.slice(0, 10))
    ).toEqual(["2005-06-11", "2005-06-17", "2005-06-29"])
    expect(result.receipt.sql.at(-1)).toContain(
      "FROM log_events_idx WHERE log_events_idx.dataset = $1"
    )
  })

  it("starts weeks on Monday and covers the whole span without a window", async () => {
    const result = await trend({ dataset: "bgl", bucket: "week" })
    expect(result.data.bucket_count).toBe(32)
    expect(result.data.effective_range).toEqual({
      from: BGL_FIRST,
      to: BGL_END,
    })
    expect(result.data.total).toBe(2000)
    for (const bucket of result.data.buckets)
      expect(new Date(bucket.bucket_start).getUTCDay()).toBe(1)
    // The span starts on Friday 3 June and ends on Tuesday 3 January.
    expect(result.data.buckets[0]).toMatchObject({
      bucket_start: "2005-05-30T00:00:00.000000Z",
      bucket_end: "2005-06-06T00:00:00.000000Z",
      partial: true,
      events: 56,
    })
    expect(result.data.buckets.at(-1)).toMatchObject({
      bucket_start: "2006-01-02T00:00:00.000000Z",
      partial: true,
    })
    expect(result.data.buckets.filter((b) => b.partial)).toHaveLength(2)
  })
})

describe("data span", () => {
  it("omits buckets outside the span and marks partial edges", async () => {
    // 3 June 20:00 – 4 June 02:00: the span starts at 22:42:50; lines at 22 (4), 23 (3), 01 (1).
    const result = await trend({
      dataset: "bgl",
      bucket: "hour",
      from: "2005-06-03T20:00:00Z",
      to: "2005-06-04T02:00:00Z",
    })
    expect(result.data.data_span).toEqual({ first: BGL_FIRST, last: BGL_LAST })
    expect(result.data.effective_range).toEqual({
      from: BGL_FIRST,
      to: "2005-06-04T02:00:00.000000Z",
    })
    expect(
      result.data.buckets.map((b) => [
        b.bucket_start.slice(11, 13),
        b.events,
        b.partial,
      ])
    ).toEqual([
      ["22", 4, true],
      ["23", 3, false],
      ["00", 0, false],
      ["01", 1, false],
    ])
    expect(result.receipt.scope.windows).toEqual([
      { dataset: "bgl", from: BGL_FIRST, to: "2005-06-04T02:00:00.000000Z" },
    ])
    expect(result.notes.join(" ")).toContain("reaches beyond the data span")
  })

  it("marks a bucket cut by the window end", async () => {
    // 14 June 14:00 – 16:30: 14 (4), 15 (0), 16:00–16:30 (16).
    const result = await trend({
      dataset: "bgl",
      bucket: "hour",
      from: "2005-06-14T14:00:00Z",
      to: "2005-06-14T16:30:00Z",
    })
    expect(
      result.data.buckets.map((b) => [b.events, b.partial, b.bucket_end])
    ).toEqual([
      [4, false, "2005-06-14T15:00:00.000000Z"],
      [0, false, "2005-06-14T16:00:00.000000Z"],
      [16, true, "2005-06-14T17:00:00.000000Z"],
    ])
  })

  it("returns no buckets, no total and a note for a window outside the span", async () => {
    const result = await trend({
      dataset: "bgl",
      bucket: "day",
      from: "2004-01-01T00:00:00Z",
      to: "2004-02-01T00:00:00Z",
    })
    expect(result.data).toMatchObject({
      effective_range: null,
      bucket_count: 0,
      total: null,
      buckets: [],
      data_span: { first: BGL_FIRST, last: BGL_LAST },
    })
    expect(result.receipt.population).toBeNull()
    expect(result.receipt.sql).toHaveLength(1)
    expect(result.notes.join(" ")).toContain(
      "The requested range lies outside the data span"
    )
  })
})

describe("limits and input", () => {
  it("accepts 120 buckets and rejects 121 with a coarser bucket in the hint", async () => {
    const ok = await trend({
      dataset: "bgl",
      bucket: "hour",
      from: "2005-06-14T00:00:00Z",
      to: "2005-06-19T00:00:00Z",
    })
    expect(ok.data.bucket_count).toBe(120)
    const outcome = await run({
      dataset: "bgl",
      bucket: "hour",
      from: "2005-06-14T00:00:00Z",
      to: "2005-06-19T01:00:00Z",
    })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "limit_exceeded",
      limit: 120,
      requested: 121,
      hint: 'Use bucket "day" (6 buckets), or narrow from/to to at most 120 hours inside the data span.',
    })
  })

  it("rejects the whole span by day and suggests the week", async () => {
    const outcome = await run({ dataset: "bgl", bucket: "day" })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "limit_exceeded",
      requested: 215,
      hint: 'Use bucket "week" (32 buckets), or narrow from/to to at most 120 days inside the data span.',
    })
  })

  it("rejects a trend without or with two datasets (A-08.3)", async () => {
    for (const input of [
      { bucket: "day" },
      { dataset: ["bgl", "openstack"], bucket: "day" },
    ]) {
      const outcome = await run(input)
      expect(outcome.ok ? null : outcome.error).toMatchObject({
        code: "invalid_input",
        issues: [
          {
            path: "dataset",
            message:
              "BGL and OpenStack share no time axis; call event_trend once per dataset (bgl or openstack).",
          },
        ],
      })
    }
  })

  it("rejects BGL-only split dimensions for OpenStack", async () => {
    const outcome = await run({
      dataset: "openstack",
      bucket: "hour",
      split_by: "node",
    })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "split_by" }],
    })
  })
})

describe("split_by", () => {
  it("keeps the top 5 values as series and sums the rest as other", async () => {
    // Alert labels over the span: none 1857, KERNDTLB 60, KERNSTOR 30, APPSEV 17,
    // KERNMNTF 11; 8 more labels with 25 lines.
    const result = await trend({
      dataset: "bgl",
      bucket: "week",
      split_by: "alert_label",
    })
    expect(result.data.series).toEqual([
      { alert_label: null, events: 1857 },
      { alert_label: "KERNDTLB", events: 60 },
      { alert_label: "KERNSTOR", events: 30 },
      { alert_label: "APPSEV", events: 17 },
      { alert_label: "KERNMNTF", events: 11 },
    ])
    expect(result.data.other).toEqual({ events: 25, merged_values: 8 })
    expect(result.data.total).toBe(2000)
    // Week of 30 May: none 54, other 2; of 6 June: none 47, KERNDTLB 60; of 13 June: none 159, KERNSTOR 30, other 1.
    const [first, second, third] = result.data.buckets
    expect(
      [first, second, third].map((b) => [
        b?.events,
        b?.series.map((s) => s.events),
        b?.other_events,
      ])
    ).toEqual([
      [56, [54, 0, 0, 0, 0], 2],
      [107, [47, 60, 0, 0, 0], 0],
      [190, [159, 0, 30, 0, 0], 1],
    ])
    // Series and other add up to the bucket in every bucket, and over all buckets to the series total.
    for (const bucket of result.data.buckets) {
      const sum =
        bucket.series.reduce((acc, s) => acc + s.events, 0) +
        (bucket.other_events ?? 0)
      expect(sum).toBe(bucket.events)
    }
    result.data.series.forEach((series, index) => {
      const sum = result.data.buckets.reduce(
        (acc, b) => acc + (b.series[index]?.events ?? 0),
        0
      )
      expect(sum).toBe(series.events)
    })
    expect(result.notes.join(" ")).toContain(
      "8 other value(s) are summed as other"
    )
  })

  it("assigns facts with the bucket and the split dimension as group", async () => {
    const result = await trend({
      dataset: "bgl",
      bucket: "week",
      split_by: "alert_label",
    })
    const fact = (path: string) => result.facts.find((f) => f.path === path)
    expect(fact("/result/buckets/1/series/1/events")).toMatchObject({
      value: 60,
      metric: "events",
      unit: "log_events",
      group: {
        dataset: "bgl",
        bucket_start: "2005-06-06T00:00:00.000000Z",
        alert_label: "KERNDTLB",
      },
    })
    // A NULL label is left out of the group (facts.ts).
    expect(fact("/result/buckets/1/series/0/events")).toMatchObject({
      value: 47,
      group: { dataset: "bgl", bucket_start: "2005-06-06T00:00:00.000000Z" },
    })
    expect(fact("/result/buckets/0/other_events")).toMatchObject({
      value: 2,
      metric: "other_events",
    })
    expect(fact("/result/effective_range/from")).toMatchObject({
      value: BGL_FIRST,
      metric: "range_start",
      unit: "utc_time",
    })
    expect(fact("/result/data_span/last")).toMatchObject({ value: BGL_LAST })
    expect(fact("/scope/windows/0/to")).toMatchObject({ value: BGL_END })
    expect(fact("/result/other/events")).toMatchObject({
      value: 25,
      metric: "other_events",
      group: { dataset: "bgl" },
    })
  })

  it("splits by team through the fictional ownership", async () => {
    // KERNEL → Compute Platform (1820), APP → Workload Runtime (107),
    // MMCS → Control Plane (35), DISCOVERY and HARDWARE → Hardware Operations (38).
    const result = await trend({
      dataset: "bgl",
      bucket: "week",
      split_by: "team",
    })
    expect(result.data.series).toEqual([
      { team: "Compute Platform", events: 1820 },
      { team: "Workload Runtime", events: 107 },
      { team: "Hardware Operations", events: 38 },
      { team: "Control Plane", events: 35 },
    ])
    expect(result.data.other).toBeNull()
    expect(result.data.buckets.every((b) => b.other_events === null)).toBe(true)
  })
})

describe("receipts and reproducibility", () => {
  it("stores every SQL text, the grid and the span in the receipt", async () => {
    const result = await trend({
      dataset: "bgl",
      bucket: "day",
      from: "2005-06-01T00:00:00Z",
      to: "2005-06-10T00:00:00Z",
      split_by: "component",
    })
    const stored = await new FileReceiptStore(dir).get(
      result.receipt.receipt_id
    )
    if (stored === null) throw new Error("receipt missing")
    expect(stored.input).toEqual({
      dataset: "bgl",
      bucket: "day",
      from: "2005-06-01T00:00:00Z",
      to: "2005-06-10T00:00:00Z",
      split_by: "component",
    })
    expect(stored.sql).toHaveLength(4)
    expect(stored.sql[0]).toContain("FROM corpus_stats")
    expect(stored.sql[1]).toContain("date_trunc('day', log_events.ts)")
    expect(stored.sql[2]).toContain("dense_rank() OVER")
    expect(stored.sql[3]).toContain("PARTITION BY bucket")
    expect(stored.params).toEqual([
      ["bgl"],
      ["bgl", BGL_FIRST, "2005-06-10T00:00:00.000000Z"],
      ["bgl", BGL_FIRST, "2005-06-10T00:00:00.000000Z"],
      ["bgl", BGL_FIRST, "2005-06-10T00:00:00.000000Z"],
    ])
    expect(stored.result).toMatchObject({
      bucket_count: 7,
      data_span: { first: BGL_FIRST, last: BGL_LAST },
      total: 100,
    })
    expect(stored.row_limit).toBe(120)
    expect(stored.truncated).toBe(false)
    expect(stored.facts.length).toBe(result.facts.length)
  })

  it("is reproducible: same digest on a second run and on rerun", async () => {
    for (const input of [
      { dataset: "bgl", bucket: "week", split_by: "alert_label" },
      { dataset: "openstack", bucket: "hour", split_by: "component" },
      {
        dataset: "bgl",
        bucket: "hour",
        from: "2005-06-14T00:00:00Z",
        to: "2005-06-15T00:00:00Z",
      },
    ]) {
      const first = await trend(input)
      const second = await trend(input)
      expect(second.receipt.result_digest).toBe(first.receipt.result_digest)
      const rerun = await registry.rerun(first.receipt.receipt_id, call())
      expect(rerun.ok ? rerun.matches : rerun.error).toEqual({
        signature: true,
        data_version: true,
        result_digest: true,
      })
    }
  })

  it("gives identical buckets under every process time zone", async () => {
    const byBucket = new Map<string, unknown>()
    for (const bucket of ["day", "week"]) {
      const outputs = await Promise.all(
        ["UTC", "America/Los_Angeles", "Asia/Kolkata"].map((zone) =>
          runScript("print-trend.ts", [dir, bucket], zone)
        )
      )
      const parsed = outputs.map((output) => JSON.parse(output))
      expect(parsed[1]).toEqual(parsed[0])
      expect(parsed[2]).toEqual(parsed[0])
      byBucket.set(bucket, parsed[0])
    }
    // The window ends at 15 June 00:00 −07:00 = 07:00 UTC, inside the last day bucket.
    expect(byBucket.get("day")).toMatchObject({
      data: {
        effective_range: { from: BGL_FIRST, to: "2005-06-15T07:00:00.000000Z" },
        bucket_count: 13,
      },
    })
    expect(byBucket.get("week")).toMatchObject({
      data: {
        buckets: [
          { bucket_start: "2005-05-30T00:00:00.000000Z", partial: true },
          { bucket_start: "2005-06-06T00:00:00.000000Z", partial: false },
          { bucket_start: "2005-06-13T00:00:00.000000Z", partial: true },
        ],
      },
    })
  })
})
