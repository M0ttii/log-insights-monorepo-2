// Author: Codex golden_counts (independent LOG-13 verifier).
// Oracle derived from concept A-08/R-03 and technical § 6.1/8.2.
import { eventTrendOutputSchema } from "@workspace/domain/tools/event-trend"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { z } from "zod"

import { createGoldenHarness, integer } from "./helpers.ts"

let harness: Awaited<ReturnType<typeof createGoldenHarness>>
beforeAll(async () => {
  harness = await createGoldenHarness()
})
afterAll(async () => {
  await harness.close()
})

describe("event_trend independent full-corpus SQL", () => {
  test.each([
    {
      bucket: "hour",
      dataset: "openstack",
      from: "2017-05-16T00:00:00Z",
      to: "2017-05-17T00:00:00Z",
      step: 3_600_000,
      hasCaptureGaps: true,
    },
    {
      bucket: "day",
      dataset: "bgl",
      from: "2005-07-28T00:00:00Z",
      to: "2005-08-05T00:00:00Z",
      step: 86_400_000,
      hasCaptureGaps: true,
    },
    {
      bucket: "week",
      dataset: "bgl",
      from: "2005-06-06T00:00:00Z",
      to: "2005-09-05T00:00:00Z",
      step: 604_800_000,
      hasCaptureGaps: false,
    },
  ] as const)(
    "$dataset $bucket: UTC grid, totals, filtered zeros and capture gaps",
    async ({ bucket, dataset, from, to, step, hasCaptureGaps }) => {
      const expected = await harness.sql(
        `
      SELECT strftime(date_trunc('${bucket}', ts), '%Y-%m-%dT%H:%M:%S.%fZ') AS start,
        count(*) AS captured,
        sum(CASE WHEN level = 'ERROR' THEN 1 ELSE 0 END) AS events
      FROM log_events WHERE dataset = $1 AND ts >= $2::TIMESTAMPTZ AND ts < $3::TIMESTAMPTZ
      GROUP BY date_trunc('${bucket}', ts) ORDER BY date_trunc('${bucket}', ts)`,
        [dataset, from, to],
        z.object({
          start: z.string(),
          captured: integer,
          events: integer,
        })
      )
      const { data } = await harness.run(
        "event_trend",
        { dataset, bucket, from, to, levels: ["ERROR"] },
        eventTrendOutputSchema
      )
      const byTime = new Map(
        expected.map((row) => [Date.parse(row.start), row])
      )
      const grid = []
      for (let start = Date.parse(from); start < Date.parse(to); start += step)
        grid.push(start)
      expect(data.buckets.map((row) => Date.parse(row.bucket_start))).toEqual(
        grid
      )
      expect(data.total).toBe(
        expected.reduce((sum, row) => sum + row.events, 0)
      )
      expect(data.bucket_count).toBe(grid.length)
      for (const row of data.buckets) {
        const start = Date.parse(row.bucket_start)
        expect(Date.parse(row.bucket_end)).toBe(start + step)
        expect(row.events).toBe(byTime.get(start)?.events ?? 0)
        expect(row.capture_gap).toBe(!byTime.has(start))
        expect(row.partial).toBe(false)
        expect(row.series).toEqual([])
        expect(row.other_events).toBeNull()
      }
      expect(data.buckets.some((row) => row.capture_gap)).toBe(hasCaptureGaps)
    }
  )

  test("full BGL weekly level split has five series plus independently summed other", async () => {
    const expected = await harness.sql(
      `
      SELECT strftime(date_trunc('week', ts), '%Y-%m-%dT%H:%M:%S.%fZ') AS start,
        level, count(*) AS events
      FROM log_events WHERE dataset = 'bgl'
      GROUP BY date_trunc('week', ts), level ORDER BY date_trunc('week', ts), level ASC NULLS LAST`,
      [],
      z.object({
        start: z.string(),
        level: z.string().nullable(),
        events: integer,
      })
    )
    const totals = await harness.sql(
      `
      SELECT level, count(*) AS events FROM log_events WHERE dataset = 'bgl'
      GROUP BY level ORDER BY events DESC, level ASC NULLS LAST`,
      [],
      z.object({ level: z.string().nullable(), events: integer })
    )
    const { data } = await harness.run(
      "event_trend",
      { dataset: "bgl", bucket: "week", split_by: "level" },
      eventTrendOutputSchema
    )
    expect(data.series).toEqual(totals.slice(0, 5))
    expect(data.other).toEqual({
      events: totals.slice(5).reduce((sum, row) => sum + row.events, 0),
      merged_values: totals.length - 5,
    })
    expect(data.total).toBe(totals.reduce((sum, row) => sum + row.events, 0))
    const selected = new Set(totals.slice(0, 5).map((row) => row.level))
    for (const bucket of data.buckets) {
      const rows = expected.filter((row) => row.start === bucket.bucket_start)
      expect(bucket.events).toBe(rows.reduce((sum, row) => sum + row.events, 0))
      expect(bucket.series).toEqual(
        totals.slice(0, 5).map(({ level }) => ({
          level,
          events: rows.find((row) => row.level === level)?.events ?? 0,
        }))
      )
      expect(bucket.other_events).toBe(
        rows
          .filter((row) => !selected.has(row.level))
          .reduce((sum, row) => sum + row.events, 0)
      )
    }
  })

  test("a half-open partial hour uses its exact UTC boundaries", async () => {
    const from = "2017-05-16T00:30:00Z"
    const to = "2017-05-16T02:00:00Z"
    const expected = await harness.sql(
      `
      SELECT strftime(date_trunc('hour', ts), '%Y-%m-%dT%H:%M:%S.%fZ') AS start, count(*) AS events
      FROM log_events WHERE dataset = 'openstack' AND ts >= $1::TIMESTAMPTZ AND ts < $2::TIMESTAMPTZ
      GROUP BY date_trunc('hour', ts) ORDER BY date_trunc('hour', ts)`,
      [from, to],
      z.object({ start: z.string(), events: integer })
    )
    const { data } = await harness.run(
      "event_trend",
      { dataset: "openstack", bucket: "hour", from, to },
      eventTrendOutputSchema
    )
    expect(
      data.buckets.map((row) => ({
        start: row.bucket_start,
        events: row.events,
      }))
    ).toEqual(expected)
    expect(data.buckets.map((row) => row.partial)).toEqual([true, false])
  })

  test("outside the dataset span means no buckets and an unknown total", async () => {
    const { data } = await harness.run(
      "event_trend",
      {
        dataset: "bgl",
        bucket: "day",
        from: "2017-05-16T00:00:00Z",
        to: "2017-05-17T00:00:00Z",
      },
      eventTrendOutputSchema
    )
    expect(data).toMatchObject({
      buckets: [],
      bucket_count: 0,
      total: null,
      effective_range: null,
    })
  })
})
