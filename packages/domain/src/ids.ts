import { z } from "zod"

/**
 * Receipt and fact IDs (technical.md § 6.2, § 8.3). A receipt ID is random;
 * a fact ID is the receipt ID plus the fact's running number, counted from 1.
 * IDs are validated before they form a file path or are looked up.
 */

export const RECEIPT_ID_PATTERN = /^r_[0-9a-f]{8}$/
export const FACT_ID_PATTERN = /^r_[0-9a-f]{8}\.f[1-9][0-9]*$/

export const receiptIdSchema = z
  .string()
  .regex(RECEIPT_ID_PATTERN)
  .describe(
    "Receipt ID: r_ followed by 8 lower-case hex digits, e.g. r_7f3a9c21."
  )

export const factIdSchema = z
  .string()
  .regex(FACT_ID_PATTERN)
  .describe(
    "Fact ID as listed in a tool result's facts, e.g. r_7f3a9c21.f4. Never build it yourself."
  )

export type FactIdParts = { receiptId: string; index: number }

export function factId(receiptId: string, index: number): string {
  if (!RECEIPT_ID_PATTERN.test(receiptId))
    throw new RangeError(`invalid receipt ID: ${receiptId}`)
  if (!Number.isSafeInteger(index) || index < 1)
    throw new RangeError(`invalid fact index: ${index}`)
  return `${receiptId}.f${index}`
}

/** Splits a fact ID into receipt ID and running number; `null` if malformed. */
export function parseFactId(id: string): FactIdParts | null {
  if (!FACT_ID_PATTERN.test(id)) return null
  const [receiptId = "", rest = ""] = id.split(".f")
  const index = Number(rest)
  return Number.isSafeInteger(index) ? { receiptId, index } : null
}
