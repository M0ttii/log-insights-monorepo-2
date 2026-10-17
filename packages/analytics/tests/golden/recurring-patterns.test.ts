// Author: Codex golden_patterns (independent LOG-13 verifier).
import { readFileSync } from "node:fs"

import {
  recurringPatternsOutputSchema,
  type RecurringPatternsInput,
  type RecurringPatternsOutput,
} from "@workspace/domain/tools/recurring-patterns"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { createGoldenHarness, expectClose, integer } from "./helpers.ts"

const number = integer
const nullableNumber = number.nullable()
const rowSchema = z.object({
  pattern_id: z.string(),
  pattern: z.string(),
  component: z.string().nullable(),
  team: z.string(),
  events: number,
  first_seen: z.string().nullable(),
  last_seen: z.string().nullable(),
  example_event_id: nullableNumber,
  episodes: number,
  recurring: z.boolean(),
  active_days: number,
  active_weeks: number,
  breadth: nullableNumber,
  nodes: nullableNumber,
  racks: nullableNumber,
  instances: nullableNumber,
  requests: nullableNumber,
  components: number,
  baseline: nullableNumber,
  delta: nullableNumber,
  status: z.string().nullable(),
  first_seen_before_window: z.string().nullable(),
  comparable: z.boolean(),
  total_events: number,
  pattern_count: number,
  quiet_count: nullableNumber,
  qualifying: number,
  share_of_error_events: z.coerce.number(),
  has_breadth: z.boolean(),
  has_change: z.boolean(),
  position: number,
  not_dominated: number,
  max_episodes: number,
  max_breadth: nullableNumber,
  max_increase: nullableNumber,
  max_events: number,
})

const source = readFileSync(
  new URL("./recurring-patterns.sql", import.meta.url),
  "utf8"
)
const conflictSource = readFileSync(
  new URL("./recurring-pattern-conflicts.sql", import.meta.url),
  "utf8"
)
const orders = {
  events: "events DESC, episodes DESC, pattern_id",
  episodes: "episodes DESC, events DESC, pattern_id",
  increase: "delta DESC, events DESC, pattern_id",
  investigation_order:
    "episodes DESC, CASE WHEN has_breadth THEN breadth END DESC, CASE WHEN has_change THEN delta END DESC, events DESC, pattern_id",
}

let harness: Awaited<ReturnType<typeof createGoldenHarness>>

beforeAll(async () => {
  harness = await createGoldenHarness()
})
afterAll(async () => {
  await harness.close()
})

async function verify(input: RecurringPatternsInput) {
  const params = [
    input.dataset,
    input.from ?? null,
    input.to ?? null,
    input.node ?? null,
    input.teams?.[0] ?? null,
    input.pattern_id ?? null,
    input.only_errors ?? false,
    input.rank === "investigation_order",
  ]
  const sql = source.replace("/* GOLDEN_ORDER */", orders[input.rank])
  const rows = await harness.sql(sql, params, rowSchema)
  const result = await harness.run(
    "recurring_patterns",
    input,
    recurringPatternsOutputSchema
  )
  const data = result.data
  const first = rows[0]
  expect(first, "fixture must contain observed patterns").toBeDefined()
  if (first === undefined) throw new Error("No Golden pattern candidates")
  expect(data.events).toBe(first.total_events)
  expect(data.pattern_count).toBe(first.pattern_count)
  expect(data.quiet_count).toBe(first.quiet_count)
  expect(data.comparison.determinable).toBe(first.comparable)
  expect(data.truncated).toBe(first.qualifying > data.limit)
  expect(data.patterns.map((pattern) => pattern.pattern_id)).toEqual(
    rows.slice(0, data.limit).map((row) => row.pattern_id)
  )
  for (const [index, pattern] of data.patterns.entries()) {
    const expected = rows[index]
    if (expected === undefined) throw new Error("Missing Golden pattern")
    const {
      total_events: _total,
      pattern_count: _patterns,
      quiet_count: _quiet,
      qualifying: _qualifying,
      comparable: _comparable,
      share_of_error_events: share,
      has_breadth: _breadth,
      has_change: _change,
      position: _position,
      not_dominated: _dominated,
      max_episodes: _maxEpisodes,
      max_breadth: _maxBreadth,
      max_increase: _maxIncrease,
      max_events: _maxEvents,
      breadth: _expectedBreadth,
      nodes,
      racks,
      instances,
      requests,
      ...values
    } = expected
    expect(pattern).toMatchObject({
      ...values,
      ...(input.dataset === "bgl" ? { nodes, racks } : { instances, requests }),
    })
    expectClose(
      pattern.share_of_error_events ?? null,
      input.rank === "investigation_order" ? share : null
    )
  }
  expect(data.investigation === null).toBe(input.rank !== "investigation_order")
  if (input.rank === "investigation_order")
    await assertInvestigation(data, rows, first, sql, params)
  return { rows, data }
}

async function assertInvestigation(
  data: RecurringPatternsOutput,
  rows: z.infer<typeof rowSchema>[],
  first: z.infer<typeof rowSchema>,
  sql: string,
  params: unknown[]
) {
  const investigation = data.investigation
  if (investigation === null) throw new Error("Missing investigation")
  expect(investigation.candidates_checked).toBe(first.pattern_count)
  expect(investigation.rank_basis.criteria).toEqual([
    "episodes",
    ...(first.has_breadth ? ["breadth"] : []),
    ...(first.has_change ? ["increase"] : []),
    "events",
    "pattern_id",
  ])
  const dimensions = [
    "episodes",
    ...(first.has_breadth ? ["breadth"] : []),
    ...(first.has_change ? ["change"] : []),
  ]
  expect(investigation.dominance).toMatchObject(
    first.not_dominated === 0
      ? {
          kind: "clear_priority",
          pattern_id: first.pattern_id,
          dimensions,
          compared_with: first.pattern_count - 1,
        }
      : {
          kind: "trade_off",
          pattern_id: first.pattern_id,
          dimensions,
          not_dominated_by_first: first.not_dominated,
        }
  )
  const expectedConflicts = await harness.sql(
    conflictSource.replace("/* GOLDEN_QUERY */", sql),
    [...params, data.limit],
    z.object({
      a: z.string(),
      b: z.string(),
      b_listed: z.boolean(),
      episodes: integer,
      breadth: integer,
      change: integer,
    })
  )
  const conflictDimensions = ["episodes", "breadth", "change"] as const
  expect(
    investigation.dominance?.kind === "trade_off"
      ? investigation.dominance.conflicts
      : []
  ).toEqual(
    expectedConflicts.map((pair) => ({
      a: pair.a,
      b: pair.b,
      b_listed: pair.b_listed,
      a_ahead_in: conflictDimensions.filter((key) => pair[key] === 1),
      b_ahead_in: conflictDimensions.filter((key) => pair[key] === -1),
    }))
  )
  const leader = (
    key: "episodes" | "breadth" | "delta" | "events",
    best: number | null
  ) => {
    if (best === null) return null
    const tied = rows.filter((row) => row[key] === best)
    return {
      value: best,
      tied: tied.length,
      pattern_ids: tied.slice(0, 5).map((row) => row.pattern_id),
    }
  }
  expect(investigation.leaders).toEqual({
    episodes: leader("episodes", first.max_episodes),
    breadth: leader("breadth", first.has_breadth ? first.max_breadth : null),
    increase: leader("delta", first.has_change ? first.max_increase : null),
    events: leader("events", first.max_events),
  })
}

describe("recurring_patterns independently derived full-corpus Golden SQL", () => {
  for (const dataset of ["bgl", "openstack"] as const) {
    for (const rank of ["events", "episodes", "investigation_order"] as const) {
      it(`${dataset}: ${rank}, episodes, UTC activity, breadth and recurrence`, async () => {
        const { data } = await verify({ dataset, rank })
        expect(data.rank).toBe(rank)
      })
    }
    for (const rank of ["increase", "investigation_order"] as const) {
      it(`${dataset}: ${rank} with reference period and R-10 statuses`, async () => {
        const { data } = await verify({
          dataset,
          rank,
          from:
            dataset === "bgl" ? "2005-09-19T00:00:00Z" : "2017-05-16T00:00:00Z",
          to:
            dataset === "bgl" ? "2006-01-04T00:00:00Z" : "2017-05-17T00:00:00Z",
        })
        expect(data.rank).toBe(rank)
      })
    }
  }

  it("BGL Workload Runtime preserves determinable breadth in R-08", async () => {
    const { data } = await verify({
      dataset: "bgl",
      rank: "investigation_order",
      teams: ["Workload Runtime"],
    })
    expect(data.investigation?.rank_basis.criteria).toContain("breadth")
  })

  it("R-10: independently classified examples cover all five statuses", async () => {
    const input: RecurringPatternsInput = {
      dataset: "bgl",
      rank: "increase",
      from: "2005-08-01T00:00:00Z",
      to: "2005-09-01T00:00:00Z",
    }
    const { rows } = await verify(input)
    for (const status of [
      "new",
      "escalating",
      "reappeared",
      "ongoing",
      "quiet",
    ]) {
      const example = rows.find((row) => row.status === status)
      if (example === undefined) throw new Error(`No real ${status} fixture`)
      const { data } = await verify({
        ...input,
        rank: "events",
        pattern_id: example.pattern_id,
      })
      expect(data.patterns[0]?.status).toBe(status)
    }
  })

  it("real A/B/A chain splits into two episodes only after filtering the node", async () => {
    const [fixture] = await harness.sql(
      `WITH ordered AS (
        SELECT *, max(ts) OVER (PARTITION BY pattern_id ORDER BY ts, event_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous
        FROM log_events WHERE dataset = 'bgl' AND is_error
      ), episodes AS (
        SELECT *, sum(CASE WHEN previous IS NULL OR ts - previous >= INTERVAL '30 minutes'
          THEN 1 ELSE 0 END) OVER (PARTITION BY pattern_id ORDER BY ts, event_id
          ROWS UNBOUNDED PRECEDING) AS episode
        FROM ordered
      ), nodes AS (
        SELECT *, max(ts) OVER (PARTITION BY pattern_id, node ORDER BY ts, event_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS node_previous,
          max(episode) OVER (PARTITION BY pattern_id, node ORDER BY ts, event_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_episode
        FROM episodes WHERE node IS NOT NULL
      ) SELECT pattern_id, node,
        strftime(node_previous, '%Y-%m-%dT%H:%M:%S.%fZ') AS start,
        strftime(ts + INTERVAL '1 microsecond', '%Y-%m-%dT%H:%M:%S.%fZ') AS finish
      FROM nodes WHERE ts - node_previous >= INTERVAL '30 minutes'
        AND previous_episode = episode
      ORDER BY pattern_id, node, ts, event_id LIMIT 1`,
      [],
      z.object({
        pattern_id: z.string(),
        node: z.string(),
        start: z.string(),
        finish: z.string(),
      })
    )
    if (fixture === undefined)
      throw new Error("No real A/B/A Golden fixture found")
    const input: RecurringPatternsInput = {
      dataset: "bgl",
      pattern_id: fixture.pattern_id,
      from: fixture.start,
      to: fixture.finish,
      only_errors: true,
      rank: "episodes",
    }
    const unfiltered = await verify(input)
    const filtered = await verify({ ...input, node: fixture.node })
    expect(unfiltered.data.patterns[0]?.episodes).toBe(1)
    expect(filtered.data.patterns[0]?.episodes).toBe(2)
  })

  it("real simultaneous first events start exactly one episode", async () => {
    const [fixture] = await harness.sql(
      `SELECT pattern_id, strftime(ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS start,
        strftime(ts + INTERVAL '1 microsecond', '%Y-%m-%dT%H:%M:%S.%fZ') AS finish,
        count(*) AS events
      FROM log_events WHERE dataset = 'bgl'
      GROUP BY pattern_id, ts HAVING count(*) > 1
      ORDER BY pattern_id, ts LIMIT 1`,
      [],
      z.object({
        pattern_id: z.string(),
        start: z.string(),
        finish: z.string(),
        events: number,
      })
    )
    if (fixture === undefined)
      throw new Error("No simultaneous first events found")
    const { data } = await verify({
      dataset: "bgl",
      pattern_id: fixture.pattern_id,
      from: fixture.start,
      to: fixture.finish,
      rank: "episodes",
    })
    expect(data.patterns[0]?.episodes).toBe(1)
    expect(data.patterns[0]?.events).toBe(fixture.events)
  })

  it("S-16: the largest error pattern by events is not first by episodes", async () => {
    const { rows: byEvents } = await verify({
      dataset: "bgl",
      rank: "events",
      only_errors: true,
    })
    const { rows: byPriority } = await verify({
      dataset: "bgl",
      rank: "investigation_order",
    })
    expect(byEvents[0]?.pattern).toBe("data TLB error interrupt")
    const noisy = byPriority.find(
      (row) => row.pattern_id === byEvents[0]?.pattern_id
    )
    expect(noisy?.position).toBeGreaterThan(100)
    expect(noisy?.episodes).toBe(22)
  })
})
