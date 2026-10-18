import { z } from "zod"

/**
 * Time contract (technical.md § 6.1, concept R-03): instants cross every
 * boundary as ISO-8601 strings with `Z` or an offset and stay strings. SereneDB
 * compares them as `$n::TIMESTAMPTZ`. The helpers below only shift and align
 * windows; they work on exact epoch microseconds (`bigint`) because JavaScript
 * `Date` drops the microseconds the corpus carries.
 */

const MICROS_PER_MS = 1000n
const MICROS_PER_SECOND = 1_000_000n
const MICROS_PER_MINUTE = 60_000_000n
const MICROS_PER_HOUR = 3_600_000_000n
const MICROS_PER_DAY = 24n * MICROS_PER_HOUR
const MICROS_PER_WEEK = 7n * MICROS_PER_DAY
/** Monday 1970-01-05T00:00Z; weeks start on Monday like `date_trunc('week', …)`. */
const FIRST_MONDAY = 4n * MICROS_PER_DAY

const INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/

/** Timestamps are stored with microsecond precision; finer input is rejected, not rounded. */
export const MAX_FRACTION_DIGITS = 6

export const instantSchema = z.iso.datetime({ offset: true })

export type Instant = z.infer<typeof instantSchema>

/** A window `[from, to)`: the start is included, the end excluded (R-03). */
export type TimeRange = { from: string; to: string }

/** First and last event time of a dataset in scope; both are observed, so both are included. */
export type DataSpan = { first: string; last: string }

export type Coverage = "full" | "partial" | "none"

/**
 * Trend bucket units. second and minute serve the bounded windows of remote
 * datasets (LOG-35: at most 60 s per direct scan); over longer spans they
 * exceed the bucket limit and the hint names a coarser unit.
 */
export const bucketUnitSchema = z.enum([
  "second",
  "minute",
  "hour",
  "day",
  "week",
])

export type BucketUnit = z.infer<typeof bucketUnitSchema>

/**
 * Parses an ISO-8601 instant with `Z` or `±HH:MM` into epoch microseconds.
 * Returns `null` for anything else: a missing zone, an impossible calendar
 * date, or more than six fractional digits.
 */
export function parseInstant(value: string): bigint | null {
  const match = INSTANT_PATTERN.exec(value)
  if (!match) return null
  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction,
    sign,
    offsetHour,
    offsetMinute,
  ] = match
  if (fraction !== undefined && fraction.length > MAX_FRACTION_DIGITS)
    return null

  const parts = [year, month, day, hour, minute, second].map(Number)
  const [y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0] = parts
  const epochMs = Date.UTC(y, mo - 1, d, h, mi, s)
  // Date.UTC rolls over impossible dates (Feb 30 → Mar 2); a round trip rejects them.
  const check = new Date(epochMs)
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    check.getUTCHours() !== h ||
    check.getUTCMinutes() !== mi ||
    check.getUTCSeconds() !== s
  ) {
    return null
  }

  const micros =
    BigInt(epochMs) * MICROS_PER_MS + BigInt((fraction ?? "").padEnd(6, "0"))
  if (sign === undefined) return micros
  const oh = Number(offsetHour)
  const om = Number(offsetMinute)
  if (oh > 23 || om > 59) return null
  const offset = BigInt(oh * 60 + om) * 60_000_000n
  return sign === "+" ? micros - offset : micros + offset
}

/** Formats epoch microseconds like the tools' SQL: `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
export function formatInstant(micros: bigint): string {
  const epochMs = floorDiv(micros, MICROS_PER_MS)
  const fraction = micros - epochMs * MICROS_PER_MS
  const base = new Date(Number(epochMs)).toISOString() // YYYY-MM-DDTHH:MM:SS.mmmZ
  const millis = base.slice(20, 23)
  return `${base.slice(0, 19)}.${millis}${fraction.toString().padStart(3, "0")}Z`
}

/** The equally long period immediately before `range` (R-06, R-10). */
export function previousPeriod(range: TimeRange): TimeRange {
  const from = requireInstant(range.from)
  const to = requireInstant(range.to)
  if (from >= to) throw new RangeError("previousPeriod needs from < to")
  return { from: formatInstant(from - (to - from)), to: formatInstant(from) }
}

/**
 * How much of `range` lies inside the observed data span. `partial` and `none`
 * tell `compare`, R-10 and trends that missing events there are not zeros.
 */
export function coverage(range: TimeRange, span: DataSpan): Coverage {
  const from = requireInstant(range.from)
  const to = requireInstant(range.to)
  const first = requireInstant(span.first)
  const endExclusive = requireInstant(span.last) + 1n
  if (from >= to) throw new RangeError("coverage needs from < to")
  if (to <= first || from >= endExclusive) return "none"
  if (from >= first && to <= endExclusive) return "full"
  return "partial"
}

/** Start of the UTC bucket that contains `micros`; weeks start on Monday. */
export function truncateToBucket(micros: bigint, unit: BucketUnit): bigint {
  switch (unit) {
    case "second":
      return floorDiv(micros, MICROS_PER_SECOND) * MICROS_PER_SECOND
    case "minute":
      return floorDiv(micros, MICROS_PER_MINUTE) * MICROS_PER_MINUTE
    case "hour":
      return floorDiv(micros, MICROS_PER_HOUR) * MICROS_PER_HOUR
    case "day":
      return floorDiv(micros, MICROS_PER_DAY) * MICROS_PER_DAY
    case "week":
      return (
        FIRST_MONDAY +
        floorDiv(micros - FIRST_MONDAY, MICROS_PER_WEEK) * MICROS_PER_WEEK
      )
  }
}

function bucketLength(unit: BucketUnit): bigint {
  switch (unit) {
    case "second":
      return MICROS_PER_SECOND
    case "minute":
      return MICROS_PER_MINUTE
    case "hour":
      return MICROS_PER_HOUR
    case "day":
      return MICROS_PER_DAY
    case "week":
      return MICROS_PER_WEEK
  }
}

/**
 * Starts of every bucket that overlaps both `range` and the data span, in
 * ascending order. Buckets outside the span are not listed: no data there is
 * not an observed zero (R-03, A-08).
 */
export function bucketStarts(
  range: TimeRange,
  span: DataSpan,
  unit: BucketUnit
): string[] {
  const lower = maxBigint(
    requireInstant(range.from),
    requireInstant(span.first)
  )
  const upper = minBigint(
    requireInstant(range.to),
    requireInstant(span.last) + 1n
  )
  const starts: string[] = []
  const step = bucketLength(unit)
  for (
    let start = truncateToBucket(lower, unit);
    start < upper;
    start += step
  ) {
    starts.push(formatInstant(start))
  }
  return starts
}

/**
 * The part of `range` inside the data span, `[max(from, first), min(to,
 * last + 1 µs))`; `null` when they do not overlap. Trends cover only this
 * part: outside it there is no data, which is not a zero (R-03).
 */
export function effectiveRange(
  range: TimeRange,
  span: DataSpan
): TimeRange | null {
  const from = maxBigint(requireInstant(range.from), requireInstant(span.first))
  const to = minBigint(requireInstant(range.to), requireInstant(span.last) + 1n)
  if (from >= to) return null
  return { from: formatInstant(from), to: formatInstant(to) }
}

/**
 * Number of buckets of `unit` that overlap `range`, without listing them,
 * so a limit check stays cheap for fine buckets over long ranges.
 */
export function bucketCount(range: TimeRange, unit: BucketUnit): number {
  const from = requireInstant(range.from)
  const to = requireInstant(range.to)
  if (from >= to) return 0
  const step = bucketLength(unit)
  const first = truncateToBucket(from, unit)
  const last = truncateToBucket(to - 1n, unit)
  return Number((last - first) / step) + 1
}

/** One bucket `[start, end)` of a trend grid. */
export type BucketSlot = {
  start: string
  end: string
  /**
   * The covered range starts after `start` or ends before `end`: the bucket
   * holds less time than its unit, so a lower count there is no drop.
   */
  partial: boolean
}

/**
 * The full bucket grid of a trend: every bucket that overlaps `range`
 * (usually the effective range), in ascending order and with its end.
 * Weeks start on Monday, like `date_trunc('week', …)` in UTC.
 */
export function bucketGrid(range: TimeRange, unit: BucketUnit): BucketSlot[] {
  const from = requireInstant(range.from)
  const to = requireInstant(range.to)
  const step = bucketLength(unit)
  const slots: BucketSlot[] = []
  for (let start = truncateToBucket(from, unit); start < to; start += step) {
    const end = start + step
    slots.push({
      start: formatInstant(start),
      end: formatInstant(end),
      partial: start < from || end > to,
    })
  }
  return slots
}

/**
 * Completes observed buckets with zeros inside the data span: a bucket in
 * `starts` without a row is an observed zero. Rows are matched by instant, so
 * `…T00:00:00Z` and `…T00:00:00.000000Z` are the same bucket.
 */
export function fillBuckets<R extends { bucket: string }>(
  observed: readonly R[],
  starts: readonly string[],
  zero: (bucket: string) => R
): R[] {
  const byInstant = new Map<bigint, R>()
  for (const row of observed) byInstant.set(requireInstant(row.bucket), row)
  const filled = starts.map((start) => {
    const key = requireInstant(start)
    const row = byInstant.get(key)
    byInstant.delete(key)
    return row ?? zero(start)
  })
  if (byInstant.size > 0) {
    throw new RangeError(
      "fillBuckets got observed buckets outside the listed starts"
    )
  }
  return filled
}

function requireInstant(value: string): bigint {
  const micros = parseInstant(value)
  if (micros === null)
    throw new RangeError(`not an ISO-8601 instant with zone: ${value}`)
  return micros
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q
}

function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}
