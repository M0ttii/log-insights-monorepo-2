import { z } from "zod"

import { isSignificantIncrease } from "./compare.ts"
import { RECURRING_MIN_EPISODES } from "./thresholds.ts"

/**
 * R-10 pattern status against the previous equally long period. A status is
 * not a severity. `recurring` (R-05) is a separate flag.
 */

export const patternStatusSchema = z
  .enum(["new", "escalating", "reappeared", "ongoing", "quiet"])
  .nullable()
  .describe(
    "R-10 status; null when the pattern has no events in either period."
  )

export type PatternStatus = z.infer<typeof patternStatusSchema>

export type PatternStatusInput = {
  /** C: events of the pattern in the window. */
  current: number
  /** B: events in the previous equally long period; null when that period is not determinable (outside the data span). */
  baseline: number | null
  /** The pattern's first event in the dataset lies in the window. */
  firstEventInWindow: boolean
  /** The window starts after the dataset's first event; otherwise "new" only means "data starts here". */
  windowStartsAfterDataStart: boolean
  /** The pattern has events before the window. */
  hasEventsBeforeWindow: boolean
}

/**
 * Exactly one status by precedence New → Escalating → Reappeared → Ongoing →
 * Quiet. Without a determinable reference, Escalating, Reappeared and Quiet
 * cannot be decided and are skipped.
 */
export function patternStatus(input: PatternStatusInput): PatternStatus {
  const { current, baseline } = input
  if (input.firstEventInWindow && input.windowStartsAfterDataStart) return "new"
  if (baseline !== null && isSignificantIncrease(current, baseline))
    return "escalating"
  if (baseline === 0 && current > 0 && input.hasEventsBeforeWindow)
    return "reappeared"
  if (current > 0) return "ongoing"
  if (baseline !== null && baseline > 0) return "quiet"
  return null
}

/** R-05: two or more episodes in the window. */
export function isRecurring(episodes: number): boolean {
  return episodes >= RECURRING_MIN_EPISODES
}
