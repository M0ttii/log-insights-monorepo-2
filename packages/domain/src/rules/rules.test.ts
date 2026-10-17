import { describe, expect, it } from "vitest"

import {
  classifyChange,
  comparisonCoverage,
  referencePeriod,
} from "./compare.ts"
import { dominance, type DominanceCandidate } from "./dominance.ts"
import { investigationOrder, type RankCandidate } from "./ranking.ts"
import {
  isRecurring,
  patternStatus,
  type PatternStatusInput,
} from "./status.ts"

describe("R-06 classifyChange", () => {
  it("labels B = 0 cases without a relative change", () => {
    expect(classifyChange(0, 0)).toEqual({
      current: 0,
      baseline: 0,
      delta: 0,
      pct_change: null,
      label: "not observed in either period",
    })
    expect(classifyChange(5, 0)).toEqual({
      current: 5,
      baseline: 0,
      delta: 5,
      pct_change: null,
      label: "first observed in this comparison",
    })
  })

  it("needs doubling and at least 20 more events for significantly increased", () => {
    // Exactly doubled, exactly +20.
    expect(classifyChange(40, 20)).toMatchObject({
      delta: 20,
      pct_change: 100,
      label: "significantly increased",
    })
    // +19: doubled is not enough.
    expect(classifyChange(39, 19)).toMatchObject({
      delta: 20,
      label: "significantly increased",
    })
    expect(classifyChange(38, 19)).toMatchObject({
      delta: 19,
      pct_change: 100,
      label: null,
    })
    // +20 but not doubled.
    expect(classifyChange(41, 21)).toMatchObject({ delta: 20, label: null })
    expect(classifyChange(60, 30)).toMatchObject({
      delta: 30,
      pct_change: 100,
      label: "significantly increased",
    })
  })

  it("reports decreases and no change without a label", () => {
    expect(classifyChange(10, 20)).toEqual({
      current: 10,
      baseline: 20,
      delta: -10,
      pct_change: -50,
      label: null,
    })
    expect(classifyChange(0, 4)).toEqual({
      current: 0,
      baseline: 4,
      delta: -4,
      pct_change: -100,
      label: null,
    })
    expect(classifyChange(7, 7)).toEqual({
      current: 7,
      baseline: 7,
      delta: 0,
      pct_change: 0,
      label: null,
    })
  })

  it("accepts only non-negative integer counts", () => {
    expect(() => classifyChange(-1, 0)).toThrow(RangeError)
    expect(() => classifyChange(1.5, 1)).toThrow(RangeError)
  })
})

function input(overrides: Partial<PatternStatusInput>): PatternStatusInput {
  return {
    current: 0,
    baseline: 0,
    firstEventInWindow: false,
    windowStartsAfterDataStart: true,
    hasEventsBeforeWindow: true,
    ...overrides,
  }
}

describe("R-10 patternStatus", () => {
  it("applies the precedence New → Escalating → Reappeared → Ongoing → Quiet", () => {
    // New wins over Escalating (no events before, so B = 0 here anyway).
    expect(
      patternStatus(
        input({
          current: 50,
          baseline: 0,
          firstEventInWindow: true,
          hasEventsBeforeWindow: false,
        })
      )
    ).toBe("new")
    expect(patternStatus(input({ current: 40, baseline: 20 }))).toBe(
      "escalating"
    )
    expect(patternStatus(input({ current: 3, baseline: 0 }))).toBe("reappeared")
    expect(patternStatus(input({ current: 3, baseline: 2 }))).toBe("ongoing")
    expect(patternStatus(input({ current: 0, baseline: 2 }))).toBe("quiet")
    expect(patternStatus(input({ current: 0, baseline: 0 }))).toBeNull()
  })

  it("does not call a pattern new when the window starts with the data", () => {
    expect(
      patternStatus(
        input({
          current: 5,
          baseline: null,
          firstEventInWindow: true,
          windowStartsAfterDataStart: false,
        })
      )
    ).toBe("ongoing")
  })

  it("skips Escalating, Reappeared and Quiet without a determinable reference", () => {
    expect(patternStatus(input({ current: 400, baseline: null }))).toBe(
      "ongoing"
    )
    expect(patternStatus(input({ current: 0, baseline: null }))).toBeNull()
  })

  it("keeps a pattern without earlier events as ongoing when B = 0 but it is not new", () => {
    expect(
      patternStatus(
        input({ current: 3, baseline: 0, hasEventsBeforeWindow: false })
      )
    ).toBe("ongoing")
  })

  it("flags recurring from two episodes on", () => {
    expect(isRecurring(1)).toBe(false)
    expect(isRecurring(2)).toBe(true)
  })
})

describe("R-08 investigationOrder", () => {
  // S-16 shape: the pattern with the most lines sits in few episodes on few nodes.
  const burst: RankCandidate = {
    pattern_id: "aaaa0001",
    episodes: 2,
    breadth: 3,
    increase: 900,
    events: 50_000,
  }
  const spread: RankCandidate = {
    pattern_id: "bbbb0002",
    episodes: 12,
    breadth: 40,
    increase: 5,
    events: 300,
  }
  const twin: RankCandidate = {
    pattern_id: "0000cccc",
    episodes: 12,
    breadth: 40,
    increase: 5,
    events: 300,
  }
  const narrow: RankCandidate = {
    pattern_id: "dddd0004",
    episodes: 12,
    breadth: 8,
    increase: 50,
    events: 900,
  }

  it("ranks by episodes, breadth, increase, events, then pattern_id", () => {
    const { ranked, basis, dropped } = investigationOrder([
      burst,
      spread,
      narrow,
      twin,
    ])
    expect(ranked.map((c) => c.pattern_id)).toEqual([
      "0000cccc",
      "bbbb0002",
      "dddd0004",
      "aaaa0001",
    ])
    expect(basis).toEqual([
      "episodes",
      "breadth",
      "increase",
      "events",
      "pattern_id",
    ])
    expect(dropped).toEqual([])
  })

  it("uses increase before events", () => {
    const a = {
      pattern_id: "a",
      episodes: 3,
      breadth: 2,
      increase: 10,
      events: 10,
    }
    const b = {
      pattern_id: "b",
      episodes: 3,
      breadth: 2,
      increase: 1,
      events: 1000,
    }
    expect(investigationOrder([b, a]).ranked.map((c) => c.pattern_id)).toEqual([
      "a",
      "b",
    ])
  })

  it("drops a criterion for the whole ranking when one candidate lacks it", () => {
    const a = {
      pattern_id: "a",
      episodes: 3,
      breadth: 2,
      increase: null,
      events: 10,
    }
    const b = {
      pattern_id: "b",
      episodes: 3,
      breadth: 2,
      increase: 99,
      events: 1000,
    }
    const { ranked, basis, dropped } = investigationOrder([a, b])
    expect(dropped).toEqual(["increase"])
    expect(basis).toEqual(["episodes", "breadth", "events", "pattern_id"])
    expect(ranked.map((c) => c.pattern_id)).toEqual(["b", "a"])
  })
})

function candidate(
  pattern_id: string,
  episodes: number,
  breadth: number | null,
  change: number | null
): DominanceCandidate {
  return { pattern_id, episodes, breadth, change }
}

describe("R-09 dominance", () => {
  it("finds a clear priority 1 when one candidate is ahead or equal everywhere", () => {
    expect(
      dominance([
        candidate("a", 12, 40, 5),
        candidate("b", 12, 8, 5),
        candidate("d", 2, 3, -1),
      ])
    ).toEqual({
      kind: "clear_priority",
      pattern_id: "a",
      dimensions: ["episodes", "breadth", "change"],
    })
    expect(dominance([candidate("only", 1, 1, 0)])).toMatchObject({
      kind: "clear_priority",
      pattern_id: "only",
    })
  })

  it("names the trade-off when dimensions disagree", () => {
    expect(
      dominance([
        candidate("a", 12, 40, 5),
        candidate("b", 2, 3, 900),
        candidate("d", 1, 1, 0),
      ])
    ).toEqual({
      kind: "trade_off",
      dimensions: ["episodes", "breadth", "change"],
      leaders: [
        { dimension: "episodes", pattern_ids: ["a"] },
        { dimension: "breadth", pattern_ids: ["a"] },
        { dimension: "change", pattern_ids: ["b"] },
      ],
      conflicts: [
        {
          a: "a",
          b: "b",
          a_ahead_in: ["episodes", "breadth"],
          b_ahead_in: ["change"],
        },
      ],
    })
  })

  it("compares only episodes and breadth when change is not determinable", () => {
    expect(
      dominance([candidate("a", 12, 40, null), candidate("b", 2, 3, 900)])
    ).toEqual({
      kind: "clear_priority",
      pattern_id: "a",
      dimensions: ["episodes", "breadth"],
    })
  })

  it("reports a full tie as a conflict without a leader in front", () => {
    expect(
      dominance([candidate("a", 3, 3, 0), candidate("b", 3, 3, 0)])
    ).toEqual({
      kind: "trade_off",
      dimensions: ["episodes", "breadth", "change"],
      leaders: [
        { dimension: "episodes", pattern_ids: ["a", "b"] },
        { dimension: "breadth", pattern_ids: ["a", "b"] },
        { dimension: "change", pattern_ids: ["a", "b"] },
      ],
      conflicts: [{ a: "a", b: "b", a_ahead_in: [], b_ahead_in: [] }],
    })
  })

  it("needs at least one candidate", () => {
    expect(() => dominance([])).toThrow(RangeError)
  })
})

describe("R-06 referencePeriod", () => {
  const current = { from: "2005-08-01T00:00:00Z", to: "2005-09-01T00:00:00Z" }

  it("takes the equally long period right before", () => {
    expect(referencePeriod(current, "previous_period")).toEqual({
      ok: true,
      baseline: {
        from: "2005-07-01T00:00:00.000000Z",
        to: "2005-08-01T00:00:00.000000Z",
      },
    })
  })

  it("accepts a chosen reference of the same length, before or after", () => {
    const later = { from: "2005-10-01T00:00:00Z", to: "2005-11-01T00:00:00Z" }
    expect(referencePeriod(current, later)).toEqual({
      ok: true,
      baseline: later,
    })
    // Same instant, other offset: still 31 days and adjacent.
    expect(
      referencePeriod(current, {
        from: "2005-06-30T17:00:00-07:00",
        to: "2005-07-31T17:00:00-07:00",
      }).ok
    ).toBe(true)
  })

  it("rejects other lengths, overlaps and reversed references", () => {
    expect(
      referencePeriod(current, {
        from: "2005-07-01T00:00:00Z",
        to: "2005-07-01T00:00:00.000001Z",
      })
    ).toEqual({
      ok: false,
      reason:
        "The reference must be as long as [from, to) (R-06): 31 d expected, 1 µs given.",
    })
    expect(
      referencePeriod(current, {
        from: "2005-08-31T23:59:59Z",
        to: "2005-10-01T23:59:59Z",
      })
    ).toEqual({
      ok: false,
      reason: "The reference must not overlap [from, to).",
    })
    expect(
      referencePeriod(current, { from: current.to, to: current.from }).ok
    ).toBe(false)
  })
})

describe("comparisonCoverage", () => {
  const span = {
    first: "2005-06-03T22:42:50.675872Z",
    last: "2006-01-03T15:13:09.127918Z",
  }

  it("is determinable only when both periods overlap the data span", () => {
    expect(
      comparisonCoverage(
        { from: "2005-08-01T00:00:00Z", to: "2005-09-01T00:00:00Z" },
        { from: "2005-07-01T00:00:00Z", to: "2005-08-01T00:00:00Z" },
        span
      )
    ).toEqual({ current: "full", baseline: "full", determinable: true })
    expect(
      comparisonCoverage(
        { from: "2005-07-01T00:00:00Z", to: "2005-08-01T00:00:00Z" },
        { from: "2005-05-31T00:00:00Z", to: "2005-07-01T00:00:00Z" },
        span
      )
    ).toEqual({ current: "full", baseline: "partial", determinable: true })
    expect(
      comparisonCoverage(
        { from: "2005-06-03T00:00:00Z", to: "2005-06-04T00:00:00Z" },
        { from: "2005-06-02T00:00:00Z", to: "2005-06-03T00:00:00Z" },
        span
      )
    ).toEqual({ current: "partial", baseline: "none", determinable: false })
    // A baseline ending exactly at the first event does not contain it.
    expect(
      comparisonCoverage(
        { from: span.first, to: "2005-06-04T22:42:50.675872Z" },
        { from: "2005-06-02T22:42:50.675872Z", to: span.first },
        span
      ).baseline
    ).toBe("none")
  })
})
