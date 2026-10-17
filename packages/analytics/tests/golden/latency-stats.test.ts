// Author: Codex golden_counts (independent LOG-13 verifier).
// Oracle: concept A-12/R-01/R-02, technical § 6.1/8.2. The independent
// ordered-set percentile syntax was checked in SereneDB's aggregate docs.
import {
  latencyStatsOutputSchema,
  type LatencyStatsRow,
} from "@workspace/domain/tools/latency-stats"
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

const expectedStats = z.object({
  api_access_events: integer,
  without_request_id: integer,
  unique_requests: integer,
  latency_values: integer,
  p50_ms: z.coerce.number().nullable(),
  p90_ms: z.coerce.number().nullable(),
  p95_ms: z.coerce.number().nullable(),
  p99_ms: z.coerce.number().nullable(),
  max_ms: z.coerce.number().nullable(),
  errors_5xx: integer,
  errors_4xx: integer,
  rate_5xx: z.coerce.number().nullable(),
  rate_4xx: z.coerce.number().nullable(),
})

const statistics = `count(*) AS api_access_events,
  count(*) - count(request_id) AS without_request_id,
  count(DISTINCT request_id) AS unique_requests, count(latency_ms) AS latency_values,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms) AS p50_ms,
  percentile_cont(0.90) WITHIN GROUP (ORDER BY latency_ms) AS p90_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99_ms,
  max(latency_ms) AS max_ms,
  count(CASE WHEN http_status >= 500 AND http_status < 600 THEN 1 END) AS errors_5xx,
  count(CASE WHEN http_status >= 400 AND http_status < 500 THEN 1 END) AS errors_4xx,
  count(CASE WHEN http_status >= 500 AND http_status < 600 THEN 1 END)::DOUBLE / nullif(count(*), 0) AS rate_5xx,
  count(CASE WHEN http_status >= 400 AND http_status < 500 THEN 1 END)::DOUBLE / nullif(count(*), 0) AS rate_4xx`

function checkStats(actual: LatencyStatsRow, expected: LatencyStatsRow) {
  for (const field of [
    "api_access_events",
    "without_request_id",
    "unique_requests",
    "latency_values",
    "errors_5xx",
    "errors_4xx",
  ] as const) {
    expect(actual[field]).toBe(expected[field])
  }
  for (const field of [
    "p50_ms",
    "p90_ms",
    "p95_ms",
    "p99_ms",
    "max_ms",
    "rate_5xx",
    "rate_4xx",
  ] as const)
    expectClose(actual[field], expected[field])
}

describe("latency_stats independent full-corpus SQL", () => {
  test("all accesses: three counting units, percentiles, maxima and separate 4xx/5xx rates", async () => {
    const expected = await harness.sql(
      `SELECT ${statistics} FROM log_events
      WHERE dataset = 'openstack' AND http_status IS NOT NULL`,
      [],
      expectedStats
    )
    const { data } = await harness.run(
      "latency_stats",
      {},
      latencyStatsOutputSchema
    )
    expect(data.unit).toBe("api_accesses")
    for (const oracle of expected) checkStats(data.total, oracle)
    expect(expected).toHaveLength(1)
    expect(data.total.without_request_id).toBeGreaterThan(0)
    expect(data.total.errors_4xx).toBeGreaterThan(0)
    expect(data.total.errors_5xx).toBeGreaterThan(0)
  })

  test.each([
    { group: "endpoint", column: "endpoint" },
    { group: "method", column: "http_method" },
    { group: "status", column: "http_status" },
    { group: "component", column: "component" },
  ] as const)(
    "$group: ranked groups and other percentiles over original accesses",
    async ({ group, column }) => {
      const expected = await harness.sql(
        `SELECT ${column} AS key, ${statistics}
      FROM log_events WHERE dataset = 'openstack' AND http_status IS NOT NULL
      GROUP BY ${column} ORDER BY api_access_events DESC, key ASC NULLS LAST`,
        [],
        expectedStats.extend({
          key: z.union([z.string(), z.number()]).nullable(),
        })
      )
      const { data } = await harness.run(
        "latency_stats",
        { group_by: group, top_n: 2 },
        latencyStatsOutputSchema
      )
      expect(data.group_count).toBe(expected.length)
      expect(data.groups).toHaveLength(Math.min(2, expected.length))
      for (const [index, actual] of data.groups.entries()) {
        const oracle = expected[index]
        if (oracle === undefined)
          throw new Error("Missing independent latency group")
        expect(actual[group]).toBe(oracle.key)
        checkStats(actual, oracle)
      }
      const keys = expected.slice(2).map((row) => row.key)
      const oracleOther =
        keys.length === 0
          ? []
          : await harness.sql(
              `SELECT ${statistics} FROM log_events
        WHERE dataset = 'openstack' AND http_status IS NOT NULL
          AND ${column} IN (${keys.map((_, index) => `$${index + 1}`).join(", ")})`,
              keys,
              expectedStats
            )
      expect(data.other === null).toBe(keys.length === 0)
      expect(data.other?.groups ?? 0).toBe(keys.length)
      expect(data.truncated).toBe(keys.length > 0)
      for (const oracle of oracleOther) {
        if (data.other === null)
          throw new Error("Expected truncated latency other")
        checkStats(data.other, oracle)
      }
    }
  )

  test.each(["hour", "day"] as const)(
    "%s: UTC bucket statistics including empty captured gaps",
    async (group) => {
      const from = "2017-05-16T00:00:00Z"
      const to = "2017-05-17T00:00:00Z"
      const expected = await harness.sql(
        `SELECT strftime(date_trunc('${group}', ts), '%Y-%m-%dT%H:%M:%S.%fZ') AS key,
      ${statistics} FROM log_events WHERE dataset = 'openstack' AND http_status IS NOT NULL
        AND ts >= $1::TIMESTAMPTZ AND ts < $2::TIMESTAMPTZ
      GROUP BY date_trunc('${group}', ts) ORDER BY date_trunc('${group}', ts)`,
        [from, to],
        expectedStats.extend({ key: z.string() })
      )
      const { data } = await harness.run(
        "latency_stats",
        { group_by: group, from, to },
        latencyStatsOutputSchema
      )
      expect(data.groups).toHaveLength(group === "hour" ? 24 : 1)
      const empty: LatencyStatsRow = {
        api_access_events: 0,
        without_request_id: 0,
        unique_requests: 0,
        latency_values: 0,
        p50_ms: null,
        p90_ms: null,
        p95_ms: null,
        p99_ms: null,
        max_ms: null,
        errors_5xx: 0,
        errors_4xx: 0,
        rate_5xx: null,
        rate_4xx: null,
      }
      for (const [index, actual] of data.groups.entries()) {
        expect(Date.parse(actual.bucket_start ?? "")).toBe(
          Date.parse(from) + index * (group === "hour" ? 3_600_000 : 86_400_000)
        )
        checkStats(
          actual,
          expected.find((row) => row.key === actual.bucket_start) ?? empty
        )
      }
      expect(data.other).toBeNull()
      expect(data.truncated).toBe(false)
    }
  )

  test("scope without 5xx keeps its nonzero denominator and explicit observed-zero note", async () => {
    const expected = await harness.sql(
      `SELECT ${statistics} FROM log_events
      WHERE dataset = 'openstack' AND http_status >= 200 AND http_status < 500`,
      [],
      expectedStats
    )
    const result = await harness.run(
      "latency_stats",
      { http_status: { min: 200, max: 499 } },
      latencyStatsOutputSchema
    )
    for (const oracle of expected) checkStats(result.data.total, oracle)
    expect(result.data.total.api_access_events).toBeGreaterThan(0)
    expect(result.data.total.errors_5xx).toBe(0)
    expect(result.data.total.rate_5xx).toBe(0)
    expect(result.notes.join(" ")).toMatch(
      /no 5xx.*observed zero.*denominator/i
    )
  })
})
