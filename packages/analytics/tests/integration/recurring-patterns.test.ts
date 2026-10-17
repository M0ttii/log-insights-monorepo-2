/**
 * recurring_patterns through the registry against SereneDB with the
 * synthetic pattern fixtures (pattern-fixtures.ts). Every expected value was
 * worked out by hand from the fixture rows (see the comments there), not
 * with the tool: episodes from the gaps between consecutive events of a
 * pattern in the filtered scope, breadth as distinct nodes or instances,
 * B as the events of the day or month before, status by R-10 precedence.
 */
import { rm } from "node:fs/promises"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import { recurringPatterns } from "../../src/tools/recurring-patterns.ts"
import { temporaryDir, loadEnv } from "./helpers.ts"
import {
  buildPatternFixtures,
  NODE_A,
  patternFixtureConnection,
  STATUS_BASELINE,
  STATUS_CURRENT,
} from "./pattern-fixtures.ts"

loadEnv()

const AUGUST = { from: "2005-08-01T00:00:00Z", to: "2005-09-01T00:00:00Z" }

let db: Database
let dir: string
let registry: Registry

beforeAll(async () => {
  await buildPatternFixtures()
  db = createDatabase(patternFixtureConnection())
  dir = await temporaryDir("analytics-patterns-")
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

async function patterns(input: Record<string, unknown>) {
  const outcome = await registry.runTool("recurring_patterns", input, call())
  if (!outcome.ok) throw new Error(outcome.error.message)
  return {
    ...outcome.result,
    data: recurringPatterns.output.parse(outcome.result.data),
  }
}

async function error(input: Record<string, unknown>) {
  const outcome = await registry.runTool("recurring_patterns", input, call())
  return outcome.ok ? null : outcome.error
}

/** The listed pattern with this ID. */
function byId(data: Awaited<ReturnType<typeof patterns>>["data"], id: string) {
  const found = data.patterns.find((pattern) => pattern.pattern_id === id)
  if (found === undefined) throw new Error(`pattern ${id} not listed`)
  return found
}

describe("episodes over the filtered scope (R-05)", () => {
  it("A/B/A: one episode unfiltered, two with node = A (counterexample 1)", async () => {
    const all = await patterns({ dataset: "bgl", components: ["ABA"] })
    expect(byId(all.data, "p_aba")).toMatchObject({
      events: 3,
      episodes: 1,
      recurring: false,
      nodes: 2,
      racks: 2,
      first_seen: "2005-07-01T00:00:00.000000Z",
      last_seen: "2005-07-01T00:40:00.000000Z",
    })
    const onA = await patterns({
      dataset: "bgl",
      components: ["ABA"],
      node: NODE_A,
    })
    expect(byId(onA.data, "p_aba")).toMatchObject({
      events: 2,
      episodes: 2,
      recurring: true,
      nodes: 1,
    })
  })

  it("two events at the same first instant are one episode (counterexample 2)", async () => {
    const { data } = await patterns({ dataset: "bgl", components: ["TIE"] })
    // Rows 6 and 7 of the fixture share the instant; the lower event_id comes first.
    expect(byId(data, "p_tie")).toMatchObject({
      events: 2,
      episodes: 1,
      example_event_id: 6,
    })
  })

  it("a gap of exactly 30 min starts a new episode, 1 µs less does not", async () => {
    const { data } = await patterns({ dataset: "bgl", components: ["GAP"] })
    expect(byId(data, "p_gap30").episodes).toBe(2)
    expect(byId(data, "p_gap29").episodes).toBe(1)
  })

  it("one episode over three days is not recurring but active on 3 days (A-10.3)", async () => {
    const { data } = await patterns({ dataset: "bgl", components: ["LONG"] })
    expect(byId(data, "p_long")).toMatchObject({
      events: 75,
      episodes: 1,
      recurring: false,
      active_days: 3,
      active_weeks: 1,
      first_seen: "2005-11-01T23:40:00.000000Z",
      last_seen: "2005-11-03T00:20:00.000000Z",
    })
  })
})

describe("investigation_order (R-08, R-09)", () => {
  it("S-16: the pattern with the most lines in few episodes on one node ranks below the broad one; the trade-off is named", async () => {
    const result = await patterns({
      dataset: "bgl",
      components: ["S16"],
      ...AUGUST,
      rank: "investigation_order",
    })
    const { data } = result
    expect(data.patterns.map((p) => p.pattern_id)).toEqual([
      "p_wide",
      "p_burst",
    ])
    expect(data.events).toBe(506)
    expect(byId(data, "p_wide")).toMatchObject({
      events: 5,
      episodes: 5,
      nodes: 5,
      baseline: 0,
      delta: 5,
      status: "new",
      team: "Compute Platform",
      share_of_error_events: 5 / 506,
      levels: [
        { level: "FATAL", events: 4 },
        { level: "ERROR", events: 1 },
      ],
      labels: [],
    })
    expect(byId(data, "p_burst")).toMatchObject({
      events: 501,
      episodes: 2,
      nodes: 1,
      delta: 501,
      share_of_error_events: 501 / 506,
      labels: [{ alert_label: "KERNDTLB", events: 501 }],
    })
    expect(data.investigation).toMatchObject({
      candidates_checked: 2,
      rank_basis: {
        criteria: ["episodes", "breadth", "increase", "events", "pattern_id"],
        dropped: [],
      },
      leaders: {
        episodes: { value: 5, tied: 1, pattern_ids: ["p_wide"] },
        breadth: { value: 5, tied: 1, pattern_ids: ["p_wide"] },
        increase: { value: 501, tied: 1, pattern_ids: ["p_burst"] },
        events: { value: 501, tied: 1, pattern_ids: ["p_burst"] },
      },
      dominance: {
        kind: "trade_off",
        pattern_id: "p_wide",
        dimensions: ["episodes", "breadth", "change"],
        not_dominated_by_first: 1,
        conflicts: [
          {
            a: "p_wide",
            b: "p_burst",
            a_ahead_in: ["episodes", "breadth"],
            b_ahead_in: ["change"],
            b_listed: true,
          },
        ],
      },
    })
    expect(result.notes).toContain(
      "Episodes are not outages; ranking is a technical investigation order, not severity or business risk; business impact unknown."
    )
    // By lines alone the burst would lead.
    const byEvents = await patterns({
      dataset: "bgl",
      components: ["S16"],
      ...AUGUST,
      rank: "events",
    })
    expect(byEvents.data.patterns[0]?.pattern_id).toBe("p_burst")
  })

  it("names a candidate ahead in every dimension clear priority 1", async () => {
    const { data } = await patterns({
      dataset: "bgl",
      components: ["DOM"],
      ...AUGUST,
      rank: "investigation_order",
    })
    expect(
      data.patterns.map((p) => [p.pattern_id, p.episodes, p.nodes])
    ).toEqual([
      ["p_dom1", 4, 4],
      ["p_dom2", 2, 2],
    ])
    expect(data.investigation?.dominance).toEqual({
      kind: "clear_priority",
      pattern_id: "p_dom1",
      dimensions: ["episodes", "breadth", "change"],
      compared_with: 1,
    })
  })

  it("drops the increase for all candidates when the previous period lies outside the data span", async () => {
    const result = await patterns({
      dataset: "bgl",
      components: ["DOM"],
      rank: "investigation_order",
    })
    const { investigation, comparison } = result.data
    expect(comparison.determinable).toBe(false)
    expect(investigation?.rank_basis.criteria).toEqual([
      "episodes",
      "breadth",
      "events",
      "pattern_id",
    ])
    expect(investigation?.rank_basis.dropped).toHaveLength(1)
    expect(investigation?.rank_basis.dropped[0]?.criterion).toBe("increase")
    expect(investigation?.rank_basis.dropped[0]?.reason).toMatch(
      /outside the bgl data span/
    )
    expect(investigation?.leaders.increase).toBeNull()
    expect(investigation?.dominance).toMatchObject({
      kind: "clear_priority",
      dimensions: ["episodes", "breadth"],
    })
    expect(result.data.patterns.every((p) => p.delta === null)).toBe(true)
  })

  it("drops breadth when a candidate has events without a node", async () => {
    const { data } = await patterns({
      dataset: "bgl",
      components: ["NONODE"],
      ...AUGUST,
      rank: "investigation_order",
    })
    expect(data.patterns.map((p) => [p.pattern_id, p.nodes])).toEqual([
      ["p_nn_some", null],
      ["p_nn_all", 1],
    ])
    expect(data.investigation?.rank_basis.criteria).toEqual([
      "episodes",
      "increase",
      "events",
      "pattern_id",
    ])
    expect(data.investigation?.rank_basis.dropped[0]).toMatchObject({
      criterion: "breadth",
      reason: expect.stringMatching(/^1 of 2 candidates/),
    })
    expect(data.investigation?.leaders.breadth).toBeNull()
  })

  it("counts OpenStack 5xx accesses as candidates and has no breadth without instances", async () => {
    const result = await patterns({
      dataset: "openstack",
      rank: "investigation_order",
    })
    const { data } = result
    expect(data.events).toBe(3)
    expect(data.patterns.map((p) => [p.pattern_id, p.episodes])).toEqual([
      ["os_err", 2],
      ["os_503", 1],
    ])
    expect(byId(data, "os_err")).toMatchObject({
      instances: 2,
      requests: 2,
      share_of_error_events: 2 / 3,
      labels: null,
    })
    expect(byId(data, "os_503").instances).toBeNull()
    expect(data.investigation?.rank_basis.criteria).toEqual([
      "episodes",
      "events",
      "pattern_id",
    ])
    expect(data.investigation?.dominance).toMatchObject({
      kind: "clear_priority",
      pattern_id: "os_err",
      dimensions: ["episodes"],
    })
  })
})

describe("status (R-10)", () => {
  it("sets new, escalating, reappeared, ongoing and quiet against the previous day", async () => {
    const result = await patterns({
      dataset: "bgl",
      components: ["STAT"],
      ...STATUS_CURRENT,
      rank: "events",
      limit: 25,
    })
    const { data } = result
    expect(data.comparison).toEqual({
      baseline: {
        from: STATUS_BASELINE.from.replace("Z", ".000000Z"),
        to: STATUS_BASELINE.to.replace("Z", ".000000Z"),
      },
      coverage: { current: "full", baseline: "full" },
      determinable: true,
    })
    expect(
      data.patterns.map((p) => [
        p.pattern_id,
        p.events,
        p.baseline,
        p.delta,
        p.status,
      ])
    ).toEqual([
      ["p_esc", 40, 20, 20, "escalating"],
      ["p_ong", 5, 5, 0, "ongoing"],
      ["p_new", 2, 0, 2, "new"],
      ["p_reap", 1, 0, 1, "reappeared"],
      ["p_quiet", 0, 3, -3, "quiet"],
    ])
    expect(data).toMatchObject({ pattern_count: 4, quiet_count: 1 })
    expect(byId(data, "p_reap").first_seen_before_window).toBe(
      "2005-09-01T01:00:00.000000Z"
    )
    expect(byId(data, "p_quiet")).toMatchObject({
      episodes: 0,
      first_seen: null,
      example_event_id: null,
      nodes: 0,
    })
  })

  it("looks for earlier events with the same filters: p_reap is new on its own node", async () => {
    const { data } = await patterns({
      dataset: "bgl",
      components: ["STAT"],
      node: "R02-M0-N0-C:J02-U01",
      ...STATUS_CURRENT,
    })
    expect(byId(data, "p_reap")).toMatchObject({
      status: "new",
      first_seen_before_window: null,
    })
  })
})

describe("contract", () => {
  it("rejects text and limit 6 with investigation_order, with a correction hint", async () => {
    const withText = await error({
      dataset: "bgl",
      rank: "investigation_order",
      text: "parity",
    })
    expect(withText).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "text" }],
      hint: expect.stringMatching(/remove text, request_id, pattern_id/),
    })
    expect(
      await error({ dataset: "bgl", rank: "investigation_order", limit: 6 })
    ).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "limit" }],
      hint: expect.stringMatching(/limit 1–5/),
    })
    expect(await error({ rank: "episodes" })).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "dataset" }],
    })
    expect(
      await error({ dataset: "bgl", components: ["DOM"], rank: "increase" })
    ).toMatchObject({ code: "invalid_input", issues: [{ path: "rank" }] })
  })

  it("records threshold, versions and every query in the receipt; digest is stable", async () => {
    const input = {
      dataset: "bgl",
      components: ["S16"],
      ...AUGUST,
      rank: "investigation_order",
    }
    const first = await patterns(input)
    const second = await patterns(input)
    expect(second.receipt.result_digest).toBe(first.receipt.result_digest)
    expect(first.data.rules).toEqual({
      rules_version: "concept-fixture",
      pattern_rules_version: "1.0.0",
      episode_gap_minutes: 30,
      recurring_min_episodes: 2,
      breadth_unit: "nodes",
    })
    // Span, manifest, main aggregate with B, history, levels and labels.
    expect(first.receipt.sql).toHaveLength(5)
    expect(first.receipt.sql[2]).toMatch(
      /lag\(e\.ts\) OVER \(PARTITION BY e\.pattern_id ORDER BY e\.ts, e\.event_id\)/
    )
    expect(first.receipt.params[2]).toContain("30 minutes")
    expect(first.receipt.input).toMatchObject({ rank: "investigation_order" })
    expect(first.receipt.scope.windows).toEqual([
      { dataset: "bgl", ...dot(AUGUST, false), period: "current" },
      {
        dataset: "bgl",
        from: "2005-07-01T00:00:00.000000Z",
        to: "2005-08-01T00:00:00.000000Z",
        period: "baseline",
      },
    ])
    expect(
      first.facts.find((fact) => fact.path === "/result/patterns/0/episodes")
    ).toMatchObject({
      value: 5,
      metric: "episodes",
      group: { pattern_id: "p_wide" },
    })
    const rerun = await registry.rerun(first.receipt.receipt_id, call())
    expect(rerun.ok && rerun.matches).toEqual({
      signature: true,
      data_version: true,
      result_digest: true,
    })
  })
})

/** The window as the tool echoes it: given bounds stay as given. */
function dot(range: { from: string; to: string }, micros: boolean) {
  return micros
    ? {
        from: range.from.replace("Z", ".000000Z"),
        to: range.to.replace("Z", ".000000Z"),
      }
    : range
}
