import type { Receipt } from "@workspace/domain/receipt"
import { describe, expect, it } from "vitest"

import { createRegistry } from "../registry.ts"

/**
 * recurring_patterns against a fake database: the queries it sends and in
 * which order, the cross-field rules of investigation_order and what is
 * skipped when the reference is not determinable. Behaviour against
 * SereneDB (episodes, breadth, status, dominance) is covered by
 * tests/integration/recurring-patterns.test.ts.
 */

const SPAN = {
  first: "2005-06-01T00:00:00.000000Z",
  last: "2005-12-31T00:00:00.000000Z",
}

type Row = Record<string, unknown>
type Call = { sql: string; params: readonly unknown[] }

const PATTERN: Row = {
  record_kind: "pattern",
  pattern_id: "p1",
  pattern: "pattern <NUM>",
  dataset: "bgl",
  component: "KERNEL",
  team: "Compute Platform",
  events: "3",
  episodes: "2",
  recurring: true,
  status: "new",
  first_seen_before_window: null,
  active_days: "1",
  active_weeks: "1",
  b1: "2",
  b2: "1",
  components: "1",
  first_seen: "2005-08-01T00:00:00.000000Z",
  last_seen: "2005-08-01T01:00:00.000000Z",
  example_event_id: "7",
  baseline: "1",
  delta: "2",
  share: 1,
  total: "3",
  active: "1",
  quiet: "0",
}

const SUMMARY: Row = {
  record_kind: "summary",
  total: "3",
  active: "1",
  quiet: "0",
  truncated: false,
  qualifying: "1",
  candidates_checked: "1",
  missing_breadth: "0",
  drop_breadth: false,
  drop_increase: false,
  not_dominated_by_first: "0",
  first_pattern_id: "p1",
  compared_with: "0",
}

function setup(rows: Row[] = [PATTERN]) {
  const calls: Call[] = []
  const stored: Receipt[] = []
  const db = {
    timeoutMs: 10_000,
    async query(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params })
      const answer = ((): Row[] => {
        if (sql === "SELECT data_version FROM load_manifest")
          return [{ data_version: "dv_test" }]
        if (sql.includes("FROM corpus_stats")) return [SPAN]
        if (sql.startsWith("WITH comparison_bounds"))
          return [
            {
              current: "full",
              baseline: String(params[2]) < SPAN.first ? "none" : "full",
              determinable: String(params[2]) >= SPAN.first,
            },
          ]
        if (sql.includes("rules_version FROM load_manifest"))
          return [
            { rules_version: "concept-3.5", pattern_rules_version: "1.0.0" },
          ]
        if (sql.startsWith("WITH cur")) return [...rows, SUMMARY]
        if (sql.includes("'level' AS kind"))
          return [
            { pattern_id: "p1", kind: "level", value: "FATAL", events: "3" },
          ]
        throw new Error(`unexpected SQL: ${sql}`)
      })()
      return { rows: answer, durationMs: 1 }
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
  const run = (input: unknown) =>
    registry.runTool("recurring_patterns", input, {
      client: "test",
      signal: new AbortController().signal,
    })
  return { calls, stored, run }
}

const toolCalls = (calls: Call[]) =>
  calls.filter((call) => call.sql !== "SELECT data_version FROM load_manifest")

describe("recurring_patterns SQL", () => {
  it("filters the window first, then forms gaps; B uses the same filter; the threshold is bound", async () => {
    const { calls, run } = setup()
    const outcome = await run({
      dataset: "bgl",
      from: "2005-08-01T00:00:00Z",
      to: "2005-09-01T00:00:00Z",
      components: ["KERNEL"],
    })
    expect(outcome.ok).toBe(true)
    const [span, coverage, manifest, main] = toolCalls(calls)
    expect(span?.params).toEqual(["bgl"])
    expect(manifest?.sql).toContain("rules_version")
    expect(coverage?.sql).toContain("comparison_coverage")
    expect(main?.sql).toContain(
      "lag(e.ts) OVER (PARTITION BY e.pattern_id ORDER BY e.ts, e.event_id) AS prev_ts FROM log_events e WHERE e.dataset = $1 AND e.component IN ($2) AND e.ts >= $4::TIMESTAMPTZ AND e.ts < $5::TIMESTAMPTZ)"
    )
    expect(main?.sql).toContain(
      "count(*) FILTER (WHERE prev_ts IS NULL OR ts - prev_ts >= $3::INTERVAL) AS episodes"
    )
    expect(main?.sql).toContain(
      "FROM log_events e WHERE e.dataset = $1 AND e.component IN ($2) AND e.ts >= $6::TIMESTAMPTZ AND e.ts < $7::TIMESTAMPTZ GROUP BY e.pattern_id"
    )
    expect(main?.sql).toContain("FULL OUTER JOIN b")
    expect(main?.sql).toContain(
      "ORDER BY episodes DESC, events DESC, pattern_id ASC"
    )
    expect(main?.params).toEqual([
      "bgl",
      "KERNEL",
      "30 minutes",
      "2005-08-01T00:00:00Z",
      "2005-09-01T00:00:00Z",
      "2005-07-01T00:00:00.000000Z",
      "2005-08-01T00:00:00.000000Z",
      2,
      2,
      20,
      "2005-08-01T00:00:00Z",
      SPAN.first,
      10,
    ])
    // History and R-10 share the aggregate statement and its exact filters.
    expect(main?.sql).toContain(
      "WHERE e.dataset = $1 AND e.component IN ($2) AND e.ts < $11::TIMESTAMPTZ AND $12::TIMESTAMPTZ < $11::TIMESTAMPTZ AND e.pattern_id IN (SELECT pattern_id FROM joined)"
    )
    expect(main?.sql).toContain("episodes >= $8::BIGINT AS recurring")
    expect(main?.sql).toContain(
      "events >= $9::BIGINT * baseline AND events - baseline >= $10::BIGINT"
    )
  })

  it("skips B and the history when the window starts with the data", async () => {
    const { calls, run } = setup([
      { ...PATTERN, baseline: null, delta: null, status: "ongoing" },
    ])
    const outcome = await run({ dataset: "bgl" })
    expect(outcome.ok).toBe(true)
    const sqls = toolCalls(calls).map((call) => call.sql)
    expect(sqls).toHaveLength(4)
    expect(sqls[3]).not.toContain("FULL OUTER JOIN")
    expect(sqls[3]).toContain("AND $9::TIMESTAMPTZ < $8::TIMESTAMPTZ")
    expect(outcome.ok && outcome.result.data).toMatchObject({
      comparison: { determinable: false },
      quiet_count: null,
      patterns: [{ baseline: null, delta: null, status: "ongoing" }],
    })
  })

  it("checks every candidate in SQL and caps listed patterns, leaders and outside conflicts there", async () => {
    const { calls, run } = setup()
    const outcome = await run({
      dataset: "openstack",
      from: "2017-05-15T00:00:00Z",
      to: "2017-05-16T00:00:00Z",
      rank: "investigation_order",
    })
    expect(outcome.ok).toBe(true)
    const main = toolCalls(calls).find((call) =>
      call.sql.startsWith("WITH cur")
    )
    expect(main?.sql).toContain(
      "(e.is_error OR (e.http_status >= 500 AND e.http_status <= 599))"
    )
    expect(main?.sql).toContain("e.instance_id AS u1, e.request_id AS u2")
    expect(main?.sql).toContain(
      "candidates AS (SELECT * FROM ruled WHERE events > 0)"
    )
    expect(main?.sql).toContain("WHERE rank <=")
    expect(main?.sql).toContain("WHERE leader_rank <=")
    expect(main?.sql).toContain("WHERE o.conflict_rank <=")
    expect(main?.params).toContain(3)
    expect(main?.params).toContain(5)
    const details = toolCalls(calls).at(-1)
    expect(details?.sql).toContain("'level' AS kind")
    expect(details?.sql).not.toContain("'label' AS kind")
  })
})

async function rejected(input: Record<string, unknown>) {
  const { calls, run } = setup()
  const outcome = await run(input)
  expect(toolCalls(calls)).toEqual([])
  return outcome.ok ? null : outcome.error
}

describe("recurring_patterns validation", () => {
  it("rejects text, request_id, pattern_id and limit > 5 with investigation_order", async () => {
    const error = await rejected({
      dataset: "bgl",
      rank: "investigation_order",
      text: "parity",
      pattern_id: "abcdef12",
      limit: 6,
    })
    expect(error).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "text" }, { path: "pattern_id" }, { path: "limit" }],
    })
    expect(error?.hint).toMatch(/remove text, request_id, pattern_id/)
    expect(error?.hint).toMatch(/limit 1–5 \(default 3\)/)
  })

  it("rejects only_errors: false with investigation_order", async () => {
    expect(
      await rejected({
        dataset: "bgl",
        rank: "investigation_order",
        only_errors: false,
      })
    ).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "only_errors" }],
    })
  })

  it("accepts limit 25 for other ranks and the shared filter rules apply", async () => {
    expect(
      await rejected({
        dataset: "openstack",
        node: "R02-M1-N0-C:J12-U11",
      })
    ).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "node", message: "Only available for dataset bgl." }],
    })
    const { run } = setup()
    expect((await run({ dataset: "bgl", limit: 25 })).ok).toBe(true)
  })

  it("rejects rank increase when the previous period is outside the data span", async () => {
    const { calls, run } = setup()
    const outcome = await run({ dataset: "bgl", rank: "increase" })
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "invalid_input", issues: [{ path: "rank" }] },
    })
    // Only the data span was read.
    expect(toolCalls(calls)).toHaveLength(2)
  })
})
