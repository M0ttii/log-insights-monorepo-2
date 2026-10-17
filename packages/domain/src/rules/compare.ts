import { z } from "zod"

import {
  SIGNIFICANT_INCREASE_FACTOR,
  SIGNIFICANT_INCREASE_MIN_EVENTS,
} from "./thresholds.ts"

/**
 * R-06 period comparison on counts SereneDB already computed: current period
 * C and equally long reference period B with the same filters.
 */

export const changeLabelSchema = z
  .enum([
    "first observed in this comparison",
    "not observed in either period",
    "significantly increased",
  ])
  .nullable()
  .describe("R-06 label; null when none applies.")

export type ChangeLabel = z.infer<typeof changeLabelSchema>

export type Change = {
  current: number
  baseline: number
  delta: number
  /** 100 · (C − B) / B in percent; null when B = 0 (no relative change exists). */
  pct_change: number | null
  label: ChangeLabel
}

export function classifyChange(current: number, baseline: number): Change {
  requireCount(current, "current")
  requireCount(baseline, "baseline")
  const delta = current - baseline
  return {
    current,
    baseline,
    delta,
    pct_change: baseline > 0 ? (100 * delta) / baseline : null,
    label: labelOf(current, baseline, delta),
  }
}

/** R-06 "significantly increased": B > 0, at least doubled, at least 20 more events. */
export function isSignificantIncrease(
  current: number,
  baseline: number
): boolean {
  return (
    baseline > 0 &&
    current >= SIGNIFICANT_INCREASE_FACTOR * baseline &&
    current - baseline >= SIGNIFICANT_INCREASE_MIN_EVENTS
  )
}

function labelOf(
  current: number,
  baseline: number,
  delta: number
): ChangeLabel {
  if (baseline === 0)
    return current > 0
      ? "first observed in this comparison"
      : "not observed in either period"
  return delta > 0 && isSignificantIncrease(current, baseline)
    ? "significantly increased"
    : null
}

function requireCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${name} must be a non-negative safe integer, got ${value}`
    )
  }
}
