import { describe, expect, it } from "vitest"

import { buildFacts } from "../facts.ts"
import {
  INVESTIGATION_DEFAULT_LIMIT,
  INVESTIGATION_LIMITS,
  RECURRING_DEFAULT_LIMIT,
  recurringPatternsFactSpecs,
  recurringPatternsInputSchema,
  recurringPatternsOutputSchema,
  resolvedLimit,
  type RecurringPatternsOutput,
} from "./recurring-patterns.ts"

const PATTERN = {
  pattern_id: "20306c79d929c187",
  pattern: "instruction address: <ADDR>",
  component: "KERNEL",
  team: "Compute Platform",
  events: 47563,
  first_seen: "2005-06-05T07:49:47.926325Z",
  last_seen: "2006-01-03T10:00:00.000000Z",
  episodes: 289,
  recurring: true,
  active_days: 146,
  active_weeks: 32,
  nodes: 22791,
  racks: 64,
  components: 1,
  baseline: null,
  delta: null,
  status: "ongoing" as const,
  first_seen_before_window: null,
  example_event_id: 29727,
  share_of_error_events: 0.048,
  levels: [{ level: "FATAL", events: 47563 }],
  labels: [],
}

const DATA: RecurringPatternsOutput = {
  dataset: "bgl",
  rank: "investigation_order",
  limit: 1,
  rules: {
    rules_version: "concept-3.5",
    pattern_rules_version: "1.0.0",
    episode_gap_minutes: 30,
    recurring_min_episodes: 2,
    breadth_unit: "nodes",
  },
  comparison: {
    baseline: {
      from: "2004-11-01T05:25:35.493918Z",
      to: "2005-06-03T22:42:50.363779Z",
    },
    coverage: { current: "full", baseline: "none" },
    determinable: false,
  },
  events: 988783,
  pattern_count: 514,
  quiet_count: null,
  patterns: [PATTERN],
  truncated: true,
  investigation: {
    candidates_checked: 514,
    rank_basis: {
      criteria: ["episodes", "events", "pattern_id"],
      dropped: [
        { criterion: "breadth", reason: "17 of 514 …" },
        { criterion: "increase", reason: "outside …" },
      ],
    },
    leaders: {
      episodes: { value: 289, tied: 1, pattern_ids: ["20306c79d929c187"] },
      breadth: null,
      increase: null,
      events: { value: 152734, tied: 1, pattern_ids: ["d7c28809f189ee67"] },
    },
    dominance: {
      kind: "clear_priority",
      pattern_id: "20306c79d929c187",
      dimensions: ["episodes"],
      compared_with: 513,
    },
    limits: INVESTIGATION_LIMITS,
  },
}

describe("recurring_patterns input", () => {
  it("defaults rank to episodes and the limit per rank", () => {
    const parsed = recurringPatternsInputSchema.parse({ dataset: "bgl" })
    expect(parsed.rank).toBe("episodes")
    expect(resolvedLimit(parsed)).toBe(RECURRING_DEFAULT_LIMIT)
    expect(resolvedLimit({ rank: "investigation_order" })).toBe(
      INVESTIGATION_DEFAULT_LIMIT
    )
    expect(resolvedLimit({ rank: "investigation_order", limit: 5 })).toBe(5)
  })

  it("requires exactly one dataset and stays strict", () => {
    expect(recurringPatternsInputSchema.safeParse({}).success).toBe(false)
    expect(
      recurringPatternsInputSchema.safeParse({ dataset: ["bgl"] }).success
    ).toBe(false)
    expect(
      recurringPatternsInputSchema.safeParse({ dataset: "bgl", group_by: [] })
        .success
    ).toBe(false)
    expect(
      recurringPatternsInputSchema.safeParse({ dataset: "bgl", limit: 26 })
        .success
    ).toBe(false)
  })
})

describe("recurring_patterns facts", () => {
  it("groups every pattern number by pattern_id and skips nulls", () => {
    const data = recurringPatternsOutputSchema.parse(DATA)
    const facts = buildFacts(
      "r_00000001",
      {
        result: data,
        scope: {
          windows: [
            {
              dataset: "bgl",
              from: "2005-06-03T22:42:50.363779Z",
              to: "2006-01-04T16:00:05.233640Z",
              period: "current",
            },
          ],
          filters: {},
        },
      },
      recurringPatternsFactSpecs({ dataset: "bgl" })
    )
    const at = (path: string) => facts.find((fact) => fact.path === path)
    expect(at("/result/patterns/0/episodes")).toMatchObject({
      value: 289,
      metric: "episodes",
      group: { pattern_id: "20306c79d929c187" },
    })
    expect(at("/result/patterns/0/nodes")).toMatchObject({
      value: 22791,
      unit: "nodes",
    })
    expect(at("/result/patterns/0/levels/0/events")).toMatchObject({
      group: { pattern_id: "20306c79d929c187", level: "FATAL" },
    })
    expect(at("/result/patterns/0/share_of_error_events")).toMatchObject({
      metric: "share_of_error_events",
      unit: "ratio",
    })
    expect(at("/result/investigation/candidates_checked")?.value).toBe(514)
    expect(at("/result/investigation/leaders/events/value")).toMatchObject({
      value: 152734,
      metric: "leader_events",
    })
    expect(at("/result/rules/episode_gap_minutes")?.value).toBe(30)
    // null produces no fact: no delta, no baseline, no breadth leader.
    expect(at("/result/patterns/0/delta")).toBeUndefined()
    expect(at("/result/quiet_count")).toBeUndefined()
    expect(
      facts.some((fact) =>
        fact.path.startsWith("/result/investigation/leaders/breadth")
      )
    ).toBe(false)
    expect(at("/scope/windows/0/from")).toMatchObject({
      group: { dataset: "bgl", period: "current" },
    })
  })

  it("names the OpenStack breadth unit instances", () => {
    const leaders = recurringPatternsFactSpecs({ dataset: "openstack" }).find(
      (spec) => spec.path === "/result/investigation/leaders/breadth/value"
    )
    expect(leaders?.unit).toBe("instances")
  })
})
