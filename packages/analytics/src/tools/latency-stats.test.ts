import { describe, expect, it } from "vitest"

import { createRegistry } from "../registry.ts"

/**
 * latency_stats against a fake database: the SQL it sends, the cross-field
 * rules, the bucket limit and the text block. Behaviour against SereneDB is
 * covered by tests/integration/latency-stats.test.ts.
 */

const SPAN = {
  first: "2017-05-14T19:39:01.445000Z",
  last: "2017-05-17T12:02:35.320000Z",
}

type Row = Record<string, unknown>

const stats = (accesses: number, errors5xx: number): Row => ({
  groups: "1",
  api_access_events: String(accesses),
  without_request_id: "1",
  unique_requests: String(accesses - 1),
  latency_values: String(accesses),
  p50_ms: 250.5,
  p90_ms: 300,
  p95_ms: 310,
  p99_ms: 400,
  max_ms: 420,
  errors_5xx: String(errors5xx),
  rate_5xx: errors5xx / accesses,
  errors_4xx: "0",
  rate_4xx: 0,
})

const TOTAL: Row = { slot: "0", g: null, ...stats(10, 0), groups: "2" }

type Call = { sql: string; params: readonly unknown[] }

function setup(rows: Row[] = [TOTAL], span = SPAN) {
  const calls: Call[] = []
  const db = {
    timeoutMs: 10_000,
    async query(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params })
      const answer = ((): Row[] => {
        if (sql === "SELECT data_version FROM load_manifest")
          return [{ data_version: "dv_test" }]
        if (sql.includes("FROM corpus_stats")) return [span]
        if (sql.startsWith("WITH base")) return rows
        if (sql.includes("date_trunc")) return []
        throw new Error(`unexpected SQL: ${sql}`)
      })()
      return { rows: answer, durationMs: 1 }
    },
  }
  const registry = createRegistry({
    db,
    receipts: {
      put: async () => {},
      get: async () => null,
      list: async () => [],
    },
    log: () => undefined,
  })
  const run = (input: unknown) =>
    registry.runTool("latency_stats", input, {
      client: "test",
      signal: new AbortController().signal,
    })
  const tool = registry.tools.find((entry) => entry.name === "latency_stats")
  return { calls, run, tool }
}

const toolCalls = (calls: Call[]) =>
  calls.filter((call) => !call.sql.includes("load_manifest"))

const AGGREGATES =
  "count(*) AS api_access_events, count(*) FILTER (WHERE request_id IS NULL) AS without_request_id, count(DISTINCT request_id) AS unique_requests, count(latency_ms) AS latency_values, quantile_cont(latency_ms, [0.5, 0.9, 0.95, 0.99]) AS q, max(latency_ms) AS max_ms, count(*) FILTER (WHERE http_status BETWEEN 500 AND 599) AS errors_5xx, count(*) FILTER (WHERE http_status BETWEEN 400 AND 499) AS errors_4xx"

const OUTER =
  "slot, g AS g, groups, api_access_events, without_request_id, unique_requests, latency_values, q[1] AS p50_ms, q[2] AS p90_ms, q[3] AS p95_ms, q[4] AS p99_ms, max_ms, errors_5xx, errors_5xx::DOUBLE / NULLIF(api_access_events, 0) AS rate_5xx, errors_4xx, errors_4xx::DOUBLE / NULLIF(api_access_events, 0) AS rate_4xx"

const API =
  "log_events.dataset = 'openstack' AND log_events.http_status IS NOT NULL"

describe("latency_stats SQL", () => {
  it("computes the total in one statement over the API accesses of the window", async () => {
    const { calls, run } = setup()
    const outcome = await run({})
    expect(outcome.ok).toBe(true)
    const [span, counted] = toolCalls(calls)
    expect(span?.params).toEqual(["openstack"])
    expect(counted).toEqual({
      sql: `WITH base AS (SELECT NULL AS g, log_events.request_id, log_events.latency_ms, log_events.http_status FROM log_events WHERE log_events.ts >= $1::TIMESTAMPTZ AND log_events.ts < $2::TIMESTAMPTZ AND ${API}), agg AS (SELECT 0::BIGINT AS slot, NULL::VARCHAR AS g, 0::BIGINT AS groups, ${AGGREGATES} FROM base) SELECT ${OUTER} FROM agg`,
      params: [SPAN.first, "2017-05-17T12:02:35.320001Z"],
    })
  })

  it("ranks groups and puts every access beyond top_n into one other slot", async () => {
    const { calls, run } = setup([
      TOTAL,
      { slot: "1", g: 200, ...stats(8, 0) },
      { slot: "2", ...stats(2, 1), g: null, groups: "1" },
    ])
    const outcome = await run({
      group_by: "status",
      top_n: 1,
      endpoints: ["/v2/<ID>/servers/detail"],
      http_status: { min: 200, max: 599 },
    })
    const counted = toolCalls(calls).at(-1)
    expect(counted?.sql).toBe(
      `WITH base AS (SELECT log_events.http_status AS g, log_events.request_id, log_events.latency_ms, log_events.http_status FROM log_events WHERE log_events.ts >= $1::TIMESTAMPTZ AND log_events.ts < $2::TIMESTAMPTZ AND log_events.endpoint IN ($3) AND log_events.http_status BETWEEN $4 AND $5 AND ${API}), ranked AS (SELECT g, row_number() OVER (ORDER BY count(*) DESC, g ASC NULLS LAST) AS rank FROM base GROUP BY g), slotted AS (SELECT b.g, b.request_id, b.latency_ms, b.http_status, least(r.rank, $6::BIGINT + 1) AS slot FROM base b JOIN ranked r ON r.g IS NOT DISTINCT FROM b.g), agg AS (SELECT 0::BIGINT AS slot, NULL::INTEGER AS g, (SELECT count(*) FROM ranked) AS groups, ${AGGREGATES} FROM base UNION ALL SELECT slot, CASE WHEN slot <= $6::BIGINT THEN min(g) END AS g, count(DISTINCT g) AS groups, ${AGGREGATES} FROM slotted GROUP BY slot) SELECT ${OUTER} FROM agg ORDER BY slot`
    )
    expect(counted?.params.slice(2)).toEqual([
      "/v2/<ID>/servers/detail",
      200,
      599,
      1,
    ])
    if (!outcome.ok) throw new Error(outcome.error.message)
    const data = outcome.result.data
    expect(data).toMatchObject({
      group_count: 2,
      groups: [{ status: 200, api_access_events: 8 }],
      other: { groups: 1, api_access_events: 2, errors_5xx: 1, rate_5xx: 0.5 },
      truncated: true,
      top_n: 1,
    })
  })

  it("fails with limit_exceeded before counting when hour buckets exceed the limit", async () => {
    const { calls, run } = setup([TOTAL], {
      first: "2017-05-01T00:00:00.000000Z",
      last: "2017-05-10T00:00:00.000000Z",
    })
    const outcome = await run({ group_by: "hour" })
    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: "limit_exceeded",
        limit: 120,
        requested: 217,
        hint: 'Use group_by "day" or narrow from/to to at most 120 hours.',
      },
    })
    expect(toolCalls(calls)).toHaveLength(1)
  })
})

describe("latency_stats validation", () => {
  it("rejects BGL with a pointer to count_events", async () => {
    const { calls, run } = setup()
    const outcome = await run({ dataset: "bgl" })
    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        issues: [
          {
            path: "dataset",
            message:
              "latency_stats covers OpenStack API accesses only: BGL has no HTTP access lines. Use dataset openstack or leave it out; for error frequencies in BGL logs use count_events.",
          },
        ],
      },
    })
    expect(toolCalls(calls)).toEqual([])
  })

  it("rejects top_n without a ranked grouping and unsupported filters", async () => {
    const { run } = setup()
    for (const input of [
      { top_n: 3 },
      { group_by: "day", top_n: 3 },
      { group_by: "level" },
      { levels: ["ERROR"] },
      { instance_id: "x" },
      { http_status: { min: 500 } },
    ]) {
      const outcome = await run(input)
      expect(outcome.ok ? null : outcome.error.code).toBe("invalid_input")
    }
  })
})

describe("latency_stats text block", () => {
  it("cites counts, percentiles and rates with numerator and denominator", async () => {
    const { run, tool } = setup([
      TOTAL,
      { slot: "1", g: "/v2/<ID>/servers/detail", ...stats(10, 0) },
    ])
    const outcome = await run({ group_by: "endpoint" })
    if (!outcome.ok) throw new Error(outcome.error.message)
    const text = tool?.summarize(outcome.result) ?? ""
    const id = outcome.result.receipt.receipt_id
    expect(text).toContain(
      `latency_stats openstack by endpoint · receipt ${id}`
    )
    expect(text).toMatch(
      /1\. endpoint="\/v2\/<ID>\/servers\/detail": 10 API accesses \[r_[0-9a-f]{8}\.f\d+\]/
    )
    expect(text).toMatch(/p50 250\.5 ms \[r_[0-9a-f]{8}\.f\d+\]/)
    expect(text).toMatch(
      /5xx 0 \[r_[0-9a-f]{8}\.f\d+\] of 10 \(0 % \[r_[0-9a-f]{8}\.f\d+\]\)/
    )
    expect(text).toContain(
      "Note: no 5xx API access events in scope (observed zero, denominator 10)"
    )
  })
})
