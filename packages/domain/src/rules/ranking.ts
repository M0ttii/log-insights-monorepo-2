import { z } from "zod"

/**
 * R-08 investigation order on numbers SereneDB already computed. It is a
 * technical order for investigation, not a severity or business risk (R-09).
 * Log-line volume is deliberately not the first criterion, because bursts of a
 * single pattern inflate it.
 */

export const rankCriterionSchema = z.enum([
  "episodes",
  "breadth",
  "increase",
  "events",
  "pattern_id",
])

export type RankCriterion = z.infer<typeof rankCriterionSchema>

export type RankCandidate = {
  pattern_id: string
  /** R-05 episodes in the window. */
  episodes: number
  /** Affected units (BGL nodes, OpenStack instances or requests); null when not determinable. */
  breadth: number | null
  /** Absolute increase C − B (R-06); null without a determinable reference. */
  increase: number | null
  events: number
}

export type Ranking<T> = {
  ranked: T[]
  /** Criteria applied, in order; reported as the rank basis. */
  basis: RankCriterion[]
  /** Criteria not determinable for every candidate, dropped for the whole ranking. */
  dropped: RankCriterion[]
}

const ORDER: readonly RankCriterion[] = [
  "episodes",
  "breadth",
  "increase",
  "events",
  "pattern_id",
]

/**
 * Episodes ↓, breadth ↓, absolute increase ↓, events ↓, pattern_id ↑ (code
 * point order, a stable final tiebreaker). A criterion missing for any
 * candidate is dropped for all, so no candidate is ranked on numbers the
 * others lack.
 */
export function investigationOrder<T extends RankCandidate>(
  candidates: readonly T[]
): Ranking<T> {
  const dropped = ORDER.filter(
    (criterion) =>
      (criterion === "breadth" || criterion === "increase") &&
      candidates.some((candidate) => candidate[criterion] === null)
  )
  const basis = ORDER.filter((criterion) => !dropped.includes(criterion))
  const ranked = candidates.toSorted((a, b) => {
    for (const criterion of basis) {
      const order = compareBy(criterion, a, b)
      if (order !== 0) return order
    }
    return 0
  })
  return { ranked, basis, dropped }
}

function compareBy(
  criterion: RankCriterion,
  a: RankCandidate,
  b: RankCandidate
): number {
  if (criterion === "pattern_id") {
    return a.pattern_id < b.pattern_id
      ? -1
      : a.pattern_id > b.pattern_id
        ? 1
        : 0
  }
  const left = a[criterion]
  const right = b[criterion]
  // Criteria with a null value are dropped before sorting.
  if (left === null || right === null)
    throw new Error(`dropped criterion ${criterion} compared`)
  return right - left
}
