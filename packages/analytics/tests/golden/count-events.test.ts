// Author: Codex golden_counts (independent LOG-13 verifier).
// Oracle derived from concept A-07/A-09, R-01/R-06 and technical § 6.1/8.2.
import { countEventsOutputSchema } from "@workspace/domain/tools/count-events"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { z } from "zod"

import { createGoldenHarness, expectClose, integer } from "./helpers.ts"

let harness: Awaited<ReturnType<typeof createGoldenHarness>>
beforeAll(async () => {
  harness = await createGoldenHarness()
})
afterAll(async () => {
  await harness.close()
})

const rowSchema = z.object({
  key: z.string().nullable(),
  events: integer,
  share: z.coerce.number().nullable(),
  total: integer,
})

describe("count_events independent full-corpus SQL", () => {
  test.each([
    { dimension: "dataset", expression: "e.dataset" },
    { dimension: "team", expression: "COALESCE(o.team, 'unowned')" },
    { dimension: "component", expression: "e.component" },
    { dimension: "level", expression: "e.level" },
  ] as const)(
    "$dimension: every group, share and truncated other",
    async ({ dimension, expression }) => {
      const expected = await harness.sql(
        `
      WITH grouped AS (
        SELECT ${expression} AS key, count(*) AS events
        FROM log_events e LEFT JOIN ownership o
          ON e.dataset = o.dataset AND e.component = o.component
        GROUP BY ${expression}
      )
      SELECT key, events, events::DOUBLE / sum(events) OVER () AS share,
        sum(events) OVER () AS total
      FROM grouped ORDER BY events DESC, key ASC NULLS LAST`,
        [],
        rowSchema
      )
      const { data } = await harness.run(
        "count_events",
        { group_by: [dimension], top_n: 2 },
        countEventsOutputSchema
      )
      expect(expected.length).toBeGreaterThan(0)
      expect(data.total).toBe(expected[0]?.total)
      expect(data.group_count).toBe(expected.length)
      expect(data.truncated).toBe(expected.length > 2)
      expect(data.groups).toHaveLength(Math.min(2, expected.length))
      for (const [index, actual] of data.groups.entries()) {
        const row = expected[index]
        expect(row).toBeDefined()
        expect(actual[dimension]).toBe(row?.key)
        expect(actual.events).toBe(row?.events)
        expectClose(actual.share, row?.share ?? null)
      }
      const other = expected.slice(2)
      expect(data.other === null).toBe(other.length === 0)
      expect(data.other?.groups ?? 0).toBe(other.length)
      expect(data.other?.events ?? 0).toBe(
        other.reduce((sum, row) => sum + row.events, 0)
      )
      expectClose(
        data.other?.share ?? null,
        other.length === 0
          ? null
          : other.reduce((sum, row) => sum + (row.share ?? 0), 0)
      )
      expect(expected.some((row) => row.key === "unowned")).toBe(
        dimension === "team"
      )
      const complete = await harness.run(
        "count_events",
        { group_by: [dimension], top_n: 50 },
        countEventsOutputSchema
      )
      expect(complete.data.other).toBeNull()
      expect(complete.data.truncated).toBe(false)
      expect(complete.data.total).toBe(data.total)
      expect(
        complete.data.groups.map((row) => ({
          key: row[dimension],
          events: row.events,
        }))
      ).toEqual(expected.map(({ key, events }) => ({ key, events })))
      for (const [index, actual] of complete.data.groups.entries()) {
        expectClose(actual.share, expected[index]?.share ?? null)
      }
    }
  )

  test("two dimensions preserve missing node categories", async () => {
    const expected = await harness.sql(
      `
      SELECT dataset, node, count(*) AS events FROM log_events
      GROUP BY dataset, node ORDER BY events DESC, dataset ASC, node ASC NULLS LAST LIMIT 3`,
      [],
      z.object({
        dataset: z.string(),
        node: z.string().nullable(),
        events: integer,
      })
    )
    const { data } = await harness.run(
      "count_events",
      { group_by: ["dataset", "node"], top_n: 3 },
      countEventsOutputSchema
    )
    expect(
      data.groups.map(({ dataset, node, events }) => ({
        dataset,
        node,
        events,
      }))
    ).toEqual(expected)
    expect(
      expected.some((row) => row.dataset === "openstack" && row.node === null)
    ).toBe(true)
  })

  test("HTTP status counts API accesses, including missing request IDs", async () => {
    const expected = await harness.sql(
      `
      SELECT http_status, count(*) AS events FROM log_events
      WHERE dataset = 'openstack' AND http_status IS NOT NULL
      GROUP BY http_status ORDER BY events DESC, http_status ASC`,
      [],
      z.object({ http_status: integer, events: integer })
    )
    const { data } = await harness.run(
      "count_events",
      { dataset: "openstack", group_by: ["http_status"] },
      countEventsOutputSchema
    )
    expect(data.unit).toBe("api_accesses")
    expect(
      data.groups.map(({ http_status, events }) => ({ http_status, events }))
    ).toEqual(expected)
  })

  test.each(["previous_period", "custom"] as const)(
    "%s: C, B, deltas, percent and R-06",
    async (reference) => {
      const from = "2005-06-10T00:00:00Z"
      const to = "2005-06-17T00:00:00Z"
      const baselineFrom =
        reference === "previous_period"
          ? "2005-06-03T00:00:00Z"
          : "2005-06-24T00:00:00Z"
      const baselineTo =
        reference === "previous_period" ? from : "2005-07-01T00:00:00Z"
      const expected = await harness.sql(
        `
      WITH periods AS (
        SELECT level, 1 AS current_period FROM log_events
        WHERE dataset = 'bgl' AND ts >= $1::TIMESTAMPTZ AND ts < $2::TIMESTAMPTZ
        UNION ALL
        SELECT level, 0 AS current_period FROM log_events
        WHERE dataset = 'bgl' AND ts >= $3::TIMESTAMPTZ AND ts < $4::TIMESTAMPTZ
      ), grouped AS (
        SELECT level, sum(current_period) AS events, count(*) - sum(current_period) AS baseline
        FROM periods GROUP BY level
      )
      SELECT level, events, baseline, events - baseline AS delta,
        100.0 * (events - baseline) / nullif(baseline, 0) AS pct_change,
        events::DOUBLE / sum(events) OVER () AS share,
        CASE WHEN baseline = 0 AND events > 0 THEN 'first observed in this comparison'
          WHEN baseline = 0 AND events = 0 THEN 'not observed in either period'
          WHEN baseline > 0 AND events >= 2 * baseline AND events - baseline >= 20 THEN 'significantly increased'
          ELSE NULL END AS classification
      FROM grouped ORDER BY abs(events - baseline) DESC, events DESC, level ASC NULLS LAST`,
        [from, to, baselineFrom, baselineTo],
        z.object({
          level: z.string().nullable(),
          events: integer,
          baseline: integer,
          delta: integer,
          pct_change: z.coerce.number().nullable(),
          share: z.coerce.number().nullable(),
          classification: z.string().nullable(),
        })
      )
      const { data } = await harness.run(
        "count_events",
        {
          dataset: "bgl",
          from,
          to,
          group_by: ["level"],
          compare:
            reference === "previous_period"
              ? reference
              : { from: baselineFrom, to: baselineTo },
        },
        countEventsOutputSchema
      )
      expect(data.comparison?.determinable).toBe(true)
      expect(data.groups).toHaveLength(expected.length)
      for (const [index, actual] of data.groups.entries()) {
        const oracle = expected[index]
        expect(oracle).toBeDefined()
        expect(actual).toMatchObject({
          level: oracle?.level,
          events: oracle?.events,
          baseline: oracle?.baseline,
          delta: oracle?.delta,
          classification: oracle?.classification,
        })
        expectClose(actual.pct_change ?? null, oracle?.pct_change ?? null)
        expectClose(actual.share, oracle?.share ?? null)
      }
      expect(data.comparison?.coverage.baseline).toBe(
        reference === "previous_period" ? "partial" : "full"
      )
      const totalCurrent = expected.reduce((sum, row) => sum + row.events, 0)
      const totalBaseline = expected.reduce((sum, row) => sum + row.baseline, 0)
      expect(data.total).toBe(totalCurrent)
      expect(data.comparison?.baseline).toBe(totalBaseline)
      expect(data.comparison?.delta).toBe(totalCurrent - totalBaseline)
      expectClose(
        data.comparison?.pct_change ?? null,
        totalBaseline === 0
          ? null
          : (100 * (totalCurrent - totalBaseline)) / totalBaseline
      )
      const limited = await harness.run(
        "count_events",
        {
          dataset: "bgl",
          from,
          to,
          group_by: ["level"],
          top_n: 2,
          compare:
            reference === "previous_period"
              ? reference
              : { from: baselineFrom, to: baselineTo },
        },
        countEventsOutputSchema
      )
      const rest = expected.slice(2)
      const currentOther = rest.reduce((sum, row) => sum + row.events, 0)
      const baselineOther = rest.reduce((sum, row) => sum + row.baseline, 0)
      expect(limited.data.groups).toEqual(data.groups.slice(0, 2))
      expect(limited.data.other).toMatchObject({
        groups: rest.length,
        events: currentOther,
        baseline: baselineOther,
        delta: currentOther - baselineOther,
      })
      expectClose(
        limited.data.other?.pct_change ?? null,
        baselineOther === 0
          ? null
          : (100 * (currentOther - baselineOther)) / baselineOther
      )
      expectClose(
        limited.data.other?.share ?? null,
        currentOther / totalCurrent
      )
    }
  )

  test("reference outside data span is unknown, never a zero baseline", async () => {
    const { data } = await harness.run(
      "count_events",
      {
        dataset: "bgl",
        from: "2005-06-04T00:00:00Z",
        to: "2005-06-05T00:00:00Z",
        group_by: ["level"],
        compare: { from: "2004-01-01T00:00:00Z", to: "2004-01-02T00:00:00Z" },
      },
      countEventsOutputSchema
    )
    expect(data.total).toBeGreaterThan(0)
    expect(data.comparison).toMatchObject({
      determinable: false,
      coverage: { baseline: "none" },
      baseline: null,
      delta: null,
      pct_change: null,
      classification: null,
    })
    for (const row of data.groups)
      expect(row).toMatchObject({
        baseline: null,
        delta: null,
        pct_change: null,
        classification: null,
      })
  })
})
