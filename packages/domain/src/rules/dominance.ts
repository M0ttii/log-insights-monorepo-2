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

/** Conflicts with candidates outside the listed priorities, at most this many. */
export const MAX_OUTSIDE_CONFLICTS = 5

const conflictSchema = z.strictObject({
  a: z.string().describe("pattern_id of the candidate ranked higher (R-08)."),
  b: z.string().describe("pattern_id of the candidate ranked lower."),
  a_ahead_in: z
    .array(dominanceDimensionSchema)
    .describe("Dimensions in which a is ahead."),
  b_ahead_in: z
    .array(dominanceDimensionSchema)
    .describe(
      "Dimensions in which b is ahead; both lists empty means a tie in every dimension."
    ),
  b_listed: z
    .boolean()
    .describe(
      "b is among the listed priorities; false for a candidate further down the order that the first is not ahead of."
    ),
})

export const priorityDominanceSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("clear_priority"),
      pattern_id: z
        .string()
        .describe(
          "First candidate; it dominates every other candidate checked: clear priority 1."
        ),
      dimensions: z
        .array(dominanceDimensionSchema)
        .describe(
          "Dimensions compared; breadth and change are left out when not determinable for every candidate."
        ),
      compared_with: z
        .number()
        .int()
        .nonnegative()
        .describe("Other candidates it dominates (all checked but itself)."),
    }),
    z.strictObject({
      kind: z.literal("trade_off"),
      pattern_id: z
        .string()
        .describe("First candidate in the R-08 order; it is not dominant."),
      dimensions: z
        .array(dominanceDimensionSchema)
        .describe(
          "Dimensions compared; breadth and change are left out when not determinable for every candidate."
        ),
      not_dominated_by_first: z
        .number()
        .int()
        .positive()
        .describe(
          "Candidates checked that the first does not dominate (R-09)."
        ),
      conflicts: z
        .array(conflictSchema)
        .describe(
          `Pairs where neither dominates: every such pair among the listed priorities, then the first against at most ${MAX_OUTSIDE_CONFLICTS} unlisted candidates it does not dominate, in R-08 order.`
        ),
    }),
  ])
  .describe(
    "R-09 dominance over every candidate checked, not a score: clear priority 1, or the trade-offs to name."
  )

export type PriorityDominance = z.infer<typeof priorityDominanceSchema>

/**
 * R-09 for an investigation order: does the first candidate dominate every
 * other candidate checked? `ranked` is the whole R-08 order, the first
 * `listed` entries are the priorities shown. Without a dominant first
 * candidate the conflicts name the trade-offs among the listed priorities
 * and between the first and the unlisted candidates it is not ahead of
 * (bounded, the full count stays in `not_dominated_by_first`), so a
 * trade-off is never hidden by the list length.
 */
export function priorityDominance(
  ranked: readonly DominanceCandidate[],
  listed: number
): PriorityDominance {
  const [first, ...others] = ranked
  if (first === undefined)
    throw new RangeError("priorityDominance needs at least one candidate")
  if (!Number.isInteger(listed) || listed < 1 || listed > ranked.length)
    throw new RangeError(`listed must be 1–${ranked.length}, got ${listed}`)
  const dimensions = ALL.filter(
    (dimension) =>
      dimension === "episodes" ||
      ranked.every((candidate) => candidate[dimension] !== null)
  )
  const notDominated = others.filter(
    (other) => !dominates(first, other, dimensions)
  )
  if (notDominated.length === 0)
    return {
      kind: "clear_priority",
      pattern_id: first.pattern_id,
      dimensions,
      compared_with: others.length,
    }

  const conflict = (
    a: DominanceCandidate,
    b: DominanceCandidate,
    bListed: boolean
  ) => ({
    a: a.pattern_id,
    b: b.pattern_id,
    a_ahead_in: dimensions.filter((d) => valueOf(a, d) > valueOf(b, d)),
    b_ahead_in: dimensions.filter((d) => valueOf(b, d) > valueOf(a, d)),
    b_listed: bListed,
  })
  const shown = ranked.slice(0, listed)
  const conflicts: z.infer<typeof conflictSchema>[] = []
  shown.forEach((a, i) => {
    for (const b of shown.slice(i + 1))
      if (!dominates(a, b, dimensions) && !dominates(b, a, dimensions))
        conflicts.push(conflict(a, b, true))
  })
  const outside = new Set(ranked.slice(listed))
  for (const other of notDominated
    .filter((candidate) => outside.has(candidate))
    .slice(0, MAX_OUTSIDE_CONFLICTS))
    conflicts.push(conflict(first, other, false))

  return {
    kind: "trade_off",
    pattern_id: first.pattern_id,
    dimensions,
    not_dominated_by_first: notDominated.length,
    conflicts,
  }
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
