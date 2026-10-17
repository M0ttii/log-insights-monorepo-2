import type { Fact } from "./facts.ts"
import { canonicalJson } from "./receipt.ts"
import { formatInstant, parseInstant } from "./time.ts"

/**
 * Claim comparison for check_claims (technical.md § 8.3, concept A-14).
 * Pure functions: the tool resolves the fact, these decide whether the
 * submitted value, metric and group match it. A value that matches some
 * other fact is irrelevant; only the cited fact counts.
 *
 * Number format (§ 10, English): a comma is always a thousands separator
 * and must group exactly three digits, a dot is always the decimal point.
 * `1.204` is therefore the decimal 1.204, never 1204, and `1,20` is not a
 * number. Units, `%` and spaces inside the number are rejected; a
 * percentage passes `unit: "percent"` instead.
 */

export type ClaimField = "value" | "metric" | "group"

/** The fields of a claim the comparison reads; the schema lives in tools/check-claims. */
export type ClaimInput = {
  value: number | string
  metric: string
  group: Record<string, string | number | boolean>
  unit?: "percent" | undefined
}

export type ClaimComparison =
  | { status: "verified" }
  | { status: "mismatch"; mismatch_on: ClaimField[]; reason: string }

export type ClaimStatus =
  "verified" | "mismatch" | "unknown_fact" | "unknown_receipt"

export type ClaimCounts = {
  checked: number
  verified: number
  mismatch: number
  /** unknown_fact plus unknown_receipt. */
  unresolved: number
}

/** Exact decimal: |value| = digits · 10^-scale, scale ≥ 0. */
type Decimal = { negative: boolean; digits: bigint; scale: number }

const PLAIN_NUMBER = /^([+-])?(\d+)(?:\.(\d+))?$/
const GROUPED_NUMBER = /^([+-])?(\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/
/** What `String(number)` yields for a finite number, including exponents. */
const JS_NUMBER = /^(-)?(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/

/**
 * A time claim is a UTC prefix of the fact's instant at a component
 * boundary: month, day, hour, minute, second or 1–6 fractional digits, with
 * an optional trailing `Z`. Offsets other than UTC are rejected.
 */
const TIME_PREFIX =
  /^(\d{4})-(\d{2})(?:-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?)?)?Z?$/

const NUMBER_FORMAT_HINT =
  'write numbers as digits with comma thousands separators and a dot decimal point (4,747,963 or 37.5), without units or %; pass unit "percent" for percentages'

/**
 * Parses a claimed number. Strings follow the English number format above;
 * JSON numbers are read from their shortest decimal form, so `0.38` states
 * two decimal places. Returns `null` for anything else.
 */
export function parseClaimNumber(value: number | string): Decimal | null {
  if (typeof value === "number") return parseJsNumber(value)
  const text = value.trim()
  const match = PLAIN_NUMBER.exec(text) ?? GROUPED_NUMBER.exec(text)
  if (!match) return null
  const [, sign, integer = "", fraction = ""] = match
  return normalize({
    negative: sign === "-",
    digits: BigInt(`${integer.replaceAll(",", "")}${fraction}`),
    scale: fraction.length,
  })
}

function parseJsNumber(value: number): Decimal | null {
  if (!Number.isFinite(value)) return null
  const match = JS_NUMBER.exec(String(value))
  if (!match) return null
  const [, sign, integer = "", fraction = "", exponent = "0"] = match
  let scale = fraction.length - Number(exponent)
  let digits = BigInt(`${integer}${fraction}`)
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale)
    scale = 0
  }
  return normalize({ negative: sign === "-", digits, scale })
}

/** −0 is 0. */
function normalize(decimal: Decimal): Decimal {
  return decimal.digits === 0n ? { ...decimal, negative: false } : decimal
}

/** Rounds half away from zero to `places` decimal places. */
function roundTo(decimal: Decimal, places: number): Decimal {
  if (decimal.scale <= places) {
    return {
      ...decimal,
      digits: decimal.digits * 10n ** BigInt(places - decimal.scale),
      scale: places,
    }
  }
  const divisor = 10n ** BigInt(decimal.scale - places)
  const remainder = decimal.digits % divisor
  const quotient =
    decimal.digits / divisor + (remainder * 2n >= divisor ? 1n : 0n)
  return normalize({
    negative: decimal.negative,
    digits: quotient,
    scale: places,
  })
}

/** value · 10^places, exact. */
function shift(decimal: Decimal, places: number): Decimal {
  const scale = decimal.scale - places
  if (scale >= 0) return { ...decimal, scale }
  return {
    ...decimal,
    digits: decimal.digits * 10n ** BigInt(-scale),
    scale: 0,
  }
}

function formatDecimal(decimal: Decimal): string {
  const text = decimal.digits.toString().padStart(decimal.scale + 1, "0")
  const integer = text.slice(0, text.length - decimal.scale)
  const fraction = text.slice(text.length - decimal.scale)
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${decimal.negative ? "-" : ""}${grouped}${fraction === "" ? "" : `.${fraction}`}`
}

/**
 * Compares a claimed value with the fact's value; `null` when it matches,
 * otherwise the reason.
 *
 * - Numbers: the fact, rounded half away from zero to the decimal places
 *   the claim states, must equal the claim. Integer facts therefore match
 *   only exactly; `0.38` matches 0.375, `0.37` does not. The fact's shortest
 *   decimal form is the basis, as the model saw it in the JSON result.
 * - `unit: "percent"`: a `ratio` fact is compared as value · 100, a
 *   `percent` fact as it is; other units do not take percent. Without the
 *   unit a ratio is compared as a fraction.
 * - Times: the claim is a UTC prefix of the instant at a component boundary.
 */
export function compareClaimValue(
  claim: Pick<ClaimInput, "value" | "unit">,
  fact: Pick<Fact, "value" | "unit">
): string | null {
  if (typeof fact.value === "string") return compareTime(claim, fact.value)

  const claimed = parseClaimNumber(claim.value)
  if (claimed === null)
    return `${JSON.stringify(claim.value)} is not a number in the answer format; ${NUMBER_FORMAT_HINT}`
  const exact = parseJsNumber(fact.value)
  if (exact === null) return "the fact holds no finite number"

  let basis = exact
  if (claim.unit === "percent") {
    if (fact.unit === "ratio") basis = shift(exact, 2)
    else if (fact.unit !== "percent")
      return `unit "percent" applies to ratio and percent facts only; this fact is in ${fact.unit}`
  }
  const rounded = roundTo(basis, claimed.scale)
  if (
    rounded.negative === claimed.negative &&
    rounded.digits === claimed.digits
  )
    return null
  const asPercent = claim.unit === "percent" ? " %" : ""
  return `${formatDecimal(claimed)}${asPercent} differs from the fact ${formatDecimal(basis)}${asPercent} rounded to ${claimed.scale} decimal place${claimed.scale === 1 ? "" : "s"} (${formatDecimal(rounded)}${asPercent})`
}

function compareTime(
  claim: Pick<ClaimInput, "value" | "unit">,
  factValue: string
): string | null {
  if (claim.unit === "percent")
    return 'unit "percent" does not apply to a time fact'
  if (typeof claim.value !== "string")
    return "a time fact takes an ISO-8601 UTC string such as 2005-06-03 or 2005-06-03T15:42Z"
  const prefix = timePrefix(claim.value.trim())
  if (prefix === null)
    return `${JSON.stringify(claim.value)} is not an ISO-8601 UTC time prefix; write e.g. 2005-06-03, 2005-06-03T15:42Z or 2005-06-03T15:42:50.363779Z`
  const micros = parseInstant(factValue)
  if (micros === null) return "the fact holds no valid instant"
  const canonical = formatInstant(micros)
  if (canonical.startsWith(prefix)) return null
  return `${prefix} is not a prefix of the fact's time ${canonical}`
}

/** Normalised prefix of `YYYY-MM-DDTHH:MM:SS.ffffffZ`, or `null`. */
function timePrefix(value: string): string | null {
  const match = TIME_PREFIX.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute, second, fraction] = match
  return [
    `${year}-${month}`,
    day === undefined ? "" : `-${day}`,
    hour === undefined ? "" : `T${hour}`,
    minute === undefined ? "" : `:${minute}`,
    second === undefined ? "" : `:${second}`,
    fraction === undefined ? "" : `.${fraction}`,
  ].join("")
}

/**
 * Group values as facts store them: strings, with numbers and booleans in
 * their `String()` form (a fact's http_status 404 has the group value "404").
 */
export function normalizeClaimGroup(
  group: ClaimInput["group"]
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(group).map(([key, value]) => [key, String(value)])
  )
}

function sameGroup(
  claimed: Record<string, string>,
  fact: Record<string, string>
): boolean {
  const keys = Object.keys(claimed)
  return (
    keys.length === Object.keys(fact).length &&
    keys.every((key) => Object.hasOwn(fact, key) && fact[key] === claimed[key])
  )
}

/**
 * Compares one claim with the fact its ID resolved to. Every differing
 * field is reported, in the order value, metric, group.
 */
export function compareClaim(
  claim: ClaimInput,
  fact: Pick<Fact, "value" | "metric" | "unit" | "group">
): ClaimComparison {
  const fields: ClaimField[] = []
  const reasons: string[] = []

  const value = compareClaimValue(claim, fact)
  if (value !== null) {
    fields.push("value")
    reasons.push(`value: ${value}`)
  }
  if (claim.metric !== fact.metric) {
    fields.push("metric")
    reasons.push(
      `metric: ${JSON.stringify(claim.metric)} differs from the fact's metric ${JSON.stringify(fact.metric)}`
    )
  }
  const group = normalizeClaimGroup(claim.group)
  if (!sameGroup(group, fact.group)) {
    fields.push("group")
    reasons.push(
      `group: ${canonicalJson(group)} differs from the fact's group ${canonicalJson(fact.group)}`
    )
  }
  return fields.length === 0
    ? { status: "verified" }
    : { status: "mismatch", mismatch_on: fields, reason: reasons.join("; ") }
}

export function countClaims(statuses: readonly ClaimStatus[]): ClaimCounts {
  const counts: ClaimCounts = {
    checked: statuses.length,
    verified: 0,
    mismatch: 0,
    unresolved: 0,
  }
  for (const status of statuses) {
    if (status === "verified") counts.verified += 1
    else if (status === "mismatch") counts.mismatch += 1
    else counts.unresolved += 1
  }
  return counts
}

/**
 * The line an answer's Verification section carries (A-14.3), e.g.
 * "3 claims checked · 1 mismatch · 1 unresolved"; "1 claim" in the singular.
 */
export function verificationLine(counts: ClaimCounts): string {
  const claims = counts.checked === 1 ? "claim" : "claims"
  return `${counts.checked} ${claims} checked · ${counts.mismatch} mismatch · ${counts.unresolved} unresolved`
}
