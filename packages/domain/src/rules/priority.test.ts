import { describe, expect, it } from "vitest"

import {
  MAX_OUTSIDE_CONFLICTS,
  priorityDominance,
  type DominanceCandidate,
} from "./dominance.ts"
import { MAX_LEADER_IDS, rankLeaders, type RankCandidate } from "./ranking.ts"

/**
 * The R-08/R-09 helpers of recurring_patterns investigation_order: leaders
 * per criterion and dominance of the first candidate over every candidate
 * checked, including those beyond the listed priorities.
 */

const c = (
  pattern_id: string,
  episodes: number,
  breadth: number | null,
  change: number | null
): DominanceCandidate => ({ pattern_id, episodes, breadth, change })

describe("R-09 priorityDominance", () => {
  it("is clear priority 1 when the first dominates every candidate, listed or not", () => {
    const ranked = [c("a", 9, 9, 9), c("b", 5, 5, 5), c("x", 1, 1, 1)]
    expect(priorityDominance(ranked, 2)).toEqual({
      kind: "clear_priority",
      pattern_id: "a",
      dimensions: ["episodes", "breadth", "change"],
      compared_with: 2,
    })
  })

  it("finds a trade-off with an unlisted candidate the first is not ahead of", () => {
    // b is dominated, x (rank 3, not listed) leads in breadth.
    const ranked = [c("a", 9, 5, 5), c("b", 4, 4, 4), c("x", 2, 50, 0)]
    expect(priorityDominance(ranked, 2)).toEqual({
      kind: "trade_off",
      pattern_id: "a",
      dimensions: ["episodes", "breadth", "change"],
      not_dominated_by_first: 1,
      conflicts: [
        {
          a: "a",
          b: "x",
          a_ahead_in: ["episodes", "change"],
          b_ahead_in: ["breadth"],
          b_listed: false,
        },
      ],
    })
  })

  it("lists every conflicting pair among the shown priorities", () => {
    const ranked = [c("a", 9, 1, 0), c("b", 5, 9, 0), c("d", 3, 3, 9)]
    const result = priorityDominance(ranked, 3)
    expect(result.kind).toBe("trade_off")
    if (result.kind !== "trade_off") return
    expect(result.conflicts.map((x) => [x.a, x.b])).toEqual([
      ["a", "b"],
      ["a", "d"],
      ["b", "d"],
    ])
    expect(result.not_dominated_by_first).toBe(2)
  })

  it("treats an exact tie as not dominated, with empty ahead lists", () => {
    const result = priorityDominance([c("a", 3, 2, 1), c("b", 3, 2, 1)], 2)
    expect(result).toMatchObject({
      kind: "trade_off",
      conflicts: [{ a: "a", b: "b", a_ahead_in: [], b_ahead_in: [] }],
    })
  })

  it("leaves out dimensions not determinable for every candidate (R-09)", () => {
    const result = priorityDominance(
      [c("a", 3, null, null), c("b", 1, 7, 7)],
      1
    )
    expect(result).toEqual({
      kind: "clear_priority",
      pattern_id: "a",
      dimensions: ["episodes"],
      compared_with: 1,
    })
  })

  it("bounds the conflicts with unlisted candidates and keeps the full count", () => {
    const others = Array.from({ length: 8 }, (_, i) =>
      c(`z${i}`, 1, 100 + i, 0)
    )
    const result = priorityDominance([c("a", 9, 1, 0), ...others], 1)
    expect(result).toMatchObject({
      kind: "trade_off",
      not_dominated_by_first: 8,
    })
    if (result.kind !== "trade_off") return
    expect(result.conflicts).toHaveLength(MAX_OUTSIDE_CONFLICTS)
    expect(result.conflicts.map((x) => x.b)).toEqual([
      "z0",
      "z1",
      "z2",
      "z3",
      "z4",
    ])
  })

  it("is clear priority 1 with a single candidate", () => {
    expect(priorityDominance([c("a", 1, 1, 1)], 1)).toMatchObject({
      kind: "clear_priority",
      compared_with: 0,
    })
  })

  it("rejects an empty list and a listed count outside 1–n", () => {
    expect(() => priorityDominance([], 1)).toThrow(RangeError)
    expect(() => priorityDominance([c("a", 1, 1, 1)], 2)).toThrow(RangeError)
    expect(() => priorityDominance([c("a", 1, 1, 1)], 0)).toThrow(RangeError)
  })
})

const r = (
  pattern_id: string,
  episodes: number,
  breadth: number | null,
  increase: number | null,
  events: number
): RankCandidate => ({ pattern_id, episodes, breadth, increase, events })

describe("R-08 rankLeaders", () => {
  it("names the leader per criterion separately (S-16: lines lead elsewhere)", () => {
    const ranked = [r("wide", 5, 5, 5, 5), r("burst", 2, 1, 501, 501)]
    expect(rankLeaders(ranked)).toEqual({
      episodes: { value: 5, tied: 1, pattern_ids: ["wide"] },
      breadth: { value: 5, tied: 1, pattern_ids: ["wide"] },
      increase: { value: 501, tied: 1, pattern_ids: ["burst"] },
      events: { value: 501, tied: 1, pattern_ids: ["burst"] },
    })
  })

  it("has no leader for a criterion missing for any candidate", () => {
    const leaders = rankLeaders([r("a", 2, null, null, 3), r("b", 1, 4, 9, 9)])
    expect(leaders.breadth).toBeNull()
    expect(leaders.increase).toBeNull()
    expect(leaders.episodes).toEqual({ value: 2, tied: 1, pattern_ids: ["a"] })
  })

  it("keeps the order for ties and bounds the IDs, not the count", () => {
    const ranked = Array.from({ length: 7 }, (_, i) => r(`p${i}`, 3, 1, 0, 1))
    expect(rankLeaders(ranked).episodes).toEqual({
      value: 3,
      tied: 7,
      pattern_ids: ranked.slice(0, MAX_LEADER_IDS).map((x) => x.pattern_id),
    })
  })

  it("uses the largest (not most negative) change, and no leaders without candidates", () => {
    expect(
      rankLeaders([r("a", 1, 1, -5, 1), r("b", 1, 1, -2, 1)]).increase
    ).toMatchObject({ value: -2, pattern_ids: ["b"] })
    expect(rankLeaders([])).toEqual({
      episodes: null,
      breadth: null,
      increase: null,
      events: null,
    })
  })
})
