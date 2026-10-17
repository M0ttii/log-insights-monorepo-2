import { z } from "zod"

import {
  coverage,
  parseInstant,
  previousPeriod,
  type Coverage,
  type DataSpan,
  type TimeRange,
} from "../time.ts"
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

/**
 * Reference of a comparison (R-06): the immediately preceding equally long
 * period, or a chosen range. count_events (`compare`) and the R-10 status of
 * recurring_patterns use this one definition.
 */
export type Reference = "previous_period" | TimeRange

/**
 * The baseline period B for the current period C. A chosen range must be as
 * long as C and must not overlap it; otherwise the reason is returned.
 */
export function referencePeriod(
  current: TimeRange,
  reference: Reference
): { ok: true; baseline: TimeRange } | { ok: false; reason: string } {
  if (reference === "previous_period")
    return { ok: true, baseline: previousPeriod(current) }
  const c = toMicros(current)
  const b = toMicros(reference)
  if (b.from >= b.to)
    return { ok: false, reason: "The reference must end after it starts." }
  if (b.to - b.from !== c.to - c.from)
    return {
      ok: false,
      reason: `The reference must be as long as [from, to) (R-06): ${formatDuration(c.to - c.from)} expected, ${formatDuration(b.to - b.from)} given.`,
    }
  if (b.from < c.to && c.from < b.to)
    return {
      ok: false,
      reason: "The reference must not overlap [from, to).",
    }
  return { ok: true, baseline: reference }
}

export type ComparisonCoverage = {
  current: Coverage
  baseline: Coverage
  /** Both periods overlap the data span; otherwise no change can be stated (R-03, A-09.3). */
  determinable: boolean
}

/**
 * How much of each period lies inside the data span. A period without any
 * overlap has no observed count, so its zero is not a zero and the
 * comparison is not determinable; `partial` keeps the values but must be
 * named.
 */
export function comparisonCoverage(
  current: TimeRange,
  baseline: TimeRange,
  span: DataSpan
): ComparisonCoverage {
  const result = {
    current: coverage(current, span),
    baseline: coverage(baseline, span),
  }
  return {
    ...result,
    determinable: result.current !== "none" && result.baseline !== "none",
  }
}

function toMicros(range: TimeRange): { from: bigint; to: bigint } {
  const from = parseInstant(range.from)
  const to = parseInstant(range.to)
  if (from === null || to === null)
    throw new RangeError("not an ISO-8601 instant with zone")
  return { from, to }
}

/** Exact duration for messages, e.g. "31 d", "10 min", "1.5 s". */
function formatDuration(micros: bigint): string {
  const units: [bigint, string][] = [
    [86_400_000_000n, "d"],
    [3_600_000_000n, "h"],
    [60_000_000n, "min"],
    [1_000_000n, "s"],
  ]
  for (const [size, unit] of units)
    if (micros % size === 0n) return `${micros / size} ${unit}`
  return `${micros} µs`
}
