import { z } from "zod"

/**
 * R-09 dominance between investigation candidates. One candidate dominates
 * another when it is at least equal in episodes, breadth and change and ahead
 * in at least one of them. There is no composite risk score: without a
 * dominant candidate the answer names the trade-off.
 */

export const dominanceDimensionSchema = z.enum([
  "episodes",
  "breadth",
  "change",
])

export type DominanceDimension = z.infer<typeof dominanceDimensionSchema>

export type DominanceCandidate = {
  pattern_id: string
  episodes: number
  /** null when not determinable. */
  breadth: number | null
  /** C − B (R-06); null without a determinable reference. */
  change: number | null
}

export const dominanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("clear_priority"),
    pattern_id: z
      .string()
      .describe("Candidate that dominates all others: clear priority 1."),
    dimensions: z
      .array(dominanceDimensionSchema)
      .describe("Dimensions compared."),
  }),
  z.strictObject({
    kind: z.literal("trade_off"),
    dimensions: z
      .array(dominanceDimensionSchema)
      .describe("Dimensions compared."),
    leaders: z
      .array(
        z.strictObject({
          dimension: dominanceDimensionSchema,
          pattern_ids: z.array(z.string()),
        })
      )
      .describe("Candidates with the highest value per dimension."),
    conflicts: z
      .array(
        z.strictObject({
          a: z.string(),
          b: z.string(),
          a_ahead_in: z.array(dominanceDimensionSchema),
          b_ahead_in: z.array(dominanceDimensionSchema),
        })
      )
      .describe(
        "Pairs where neither dominates; both ahead lists empty means a tie."
      ),
  }),
])

export type Dominance = z.infer<typeof dominanceSchema>

const ALL: readonly DominanceDimension[] = ["episodes", "breadth", "change"]

/**
 * Candidates are expected in R-08 order; conflicts keep that order. A
 * dimension not determinable for every candidate is left out for all (change
 * per R-09, breadth by the same rule as R-08).
 */
export function dominance(
  candidates: readonly DominanceCandidate[]
): Dominance {
  if (candidates.length === 0)
    throw new RangeError("dominance needs at least one candidate")
  const dimensions = ALL.filter(
    (dimension) =>
      dimension === "episodes" ||
      candidates.every((candidate) => candidate[dimension] !== null)
  )

  const dominant = candidates.find((candidate) =>
    candidates.every(
      (other) => other === candidate || dominates(candidate, other, dimensions)
    )
  )
  if (dominant)
    return {
      kind: "clear_priority",
      pattern_id: dominant.pattern_id,
      dimensions,
    }

  const leaders = dimensions.map((dimension) => {
    const best = Math.max(
      ...candidates.map((candidate) => valueOf(candidate, dimension))
    )
    return {
      dimension,
      pattern_ids: candidates
        .filter((candidate) => valueOf(candidate, dimension) === best)
        .map((candidate) => candidate.pattern_id),
    }
  })

  const conflicts: Extract<Dominance, { kind: "trade_off" }>["conflicts"] = []
  candidates.forEach((a, i) => {
    for (const b of candidates.slice(i + 1)) {
      if (dominates(a, b, dimensions) || dominates(b, a, dimensions)) continue
      conflicts.push({
        a: a.pattern_id,
        b: b.pattern_id,
        a_ahead_in: dimensions.filter((d) => valueOf(a, d) > valueOf(b, d)),
        b_ahead_in: dimensions.filter((d) => valueOf(b, d) > valueOf(a, d)),
      })
    }
  })

  return { kind: "trade_off", dimensions, leaders, conflicts }
}

export function dominates(
  a: DominanceCandidate,
  b: DominanceCandidate,
  dimensions: readonly DominanceDimension[]
): boolean {
  let ahead = false
  for (const dimension of dimensions) {
    const left = valueOf(a, dimension)
    const right = valueOf(b, dimension)
    if (left < right) return false
    if (left > right) ahead = true
  }
  return ahead
}

function valueOf(
  candidate: DominanceCandidate,
  dimension: DominanceDimension
): number {
  const value = candidate[dimension]
  // Dimensions with a null value are excluded before comparing.
  if (value === null)
    throw new Error(`excluded dimension ${dimension} compared`)
  return value
}
