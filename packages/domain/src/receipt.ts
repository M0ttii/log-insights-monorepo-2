import { z } from "zod"

import { DATASET_IDS } from "./datasets.ts"
import { factSchema } from "./facts.ts"
import { datasetSchema, filterSchema } from "./filters.ts"
import { receiptIdSchema } from "./ids.ts"
import { instantSchema } from "./time.ts"

/**
 * Query receipts (technical.md § 6.2): one JSON file per tool run. This module
 * defines the shape and the canonical JSON that signature and result digest
 * hash; hashing with `node:crypto` and the file store belong to analytics (U05).
 */

/** Counting units (R-01); they are never mixed and always named. */
export const countingUnitSchema = z
  .enum(["log_events", "api_accesses", "requests"])
  .describe(
    "R-01 counting unit: log_events (parsed lines), api_accesses (OpenStack lines with HTTP status), requests (unique request IDs)."
  )

export type CountingUnit = z.infer<typeof countingUnitSchema>

export const clientSchema = z.enum(["mcp", "web", "eval", "test"])

export type Client = z.infer<typeof clientSchema>

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

/** Upper bound for the stored `result` (§ 6.2); larger results must be truncated by the tool. */
export const RESULT_MAX_BYTES = 256 * 1024

export const scopeSchema = z
  .strictObject({
    windows: z
      .array(
        z.strictObject({
          dataset: datasetSchema,
          from: instantSchema.describe("Resolved window start, inclusive."),
          to: instantSchema.describe("Resolved window end, exclusive."),
          period: z
            .enum(["current", "baseline"])
            .optional()
            .describe(
              "Only in period comparisons: current period C or reference period B."
            ),
        })
      )
      .max(DATASET_IDS.length)
      .describe(
        "One window per dataset (no two datasets share a time axis), or the two periods of a comparison within one dataset; empty for check_claims, which reads receipts, not the corpus."
      ),
    filters: filterSchema
      .omit({ dataset: true, from: true, to: true })
      .describe("Filters applied besides dataset and window."),
  })
  .describe("What the numbers cover.")

export type Scope = z.infer<typeof scopeSchema>

export const populationSchema = z
  .strictObject({
    count: z
      .number()
      .int()
      .nonnegative()
      .describe("Events, accesses or requests in scope, or total matches."),
    unit: countingUnitSchema,
  })
  .nullable()
  .describe(
    "Population in scope with its counting unit; null for tools without a corpus population (check_claims)."
  )

export type Population = z.infer<typeof populationSchema>

export const receiptSchema = z.strictObject({
  receipt_id: receiptIdSchema,
  created_at: instantSchema.describe("UTC time of the run."),
  client: clientSchema,
  tool: z.string(),
  tool_version: z.string(),
  input: z
    .json()
    .describe("Validated input with resolved defaults; basis for re-run."),
  signature: sha256Hex.describe(
    "SHA-256 over canonical JSON of tool, tool_version and input (query identity)."
  ),
  data_version: z
    .string()
    .min(1)
    .describe("load_manifest data version the run read."),
  sql: z.array(z.string()).describe("Exact SQL texts in execution order."),
  params: z.array(z.array(z.json())).describe("Bound parameters per SQL text."),
  scope: scopeSchema,
  population: populationSchema,
  rows_returned: z.number().int().nonnegative(),
  truncated: z.boolean(),
  row_limit: z.number().int().positive().nullable(),
  duration_ms: z
    .number()
    .nonnegative()
    .describe("Sum of database round trips in milliseconds."),
  result: z.json(),
  result_digest: sha256Hex.describe("SHA-256 over canonical JSON of result."),
  facts: z.array(factSchema),
})

export type Receipt = z.infer<typeof receiptSchema>

export const receiptSummarySchema = receiptSchema
  .pick({
    receipt_id: true,
    input: true,
    signature: true,
    data_version: true,
    sql: true,
    params: true,
    scope: true,
    population: true,
    rows_returned: true,
    truncated: true,
    duration_ms: true,
    result_digest: true,
  })
  .describe(
    "Receipt summary returned with every result; the full receipt is receipt://{id}."
  )

export type ReceiptSummary = z.infer<typeof receiptSummarySchema>

/**
 * Canonical JSON: object keys in code-point order, no whitespace, absent
 * (`undefined`) properties dropped. Values JSON cannot represent exactly
 * (`undefined` in arrays, non-finite numbers, `bigint`, class instances such
 * as `Date`) throw instead of being coerced, so equal inputs always give
 * equal bytes and nothing is silently lost.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value)
    case "number":
      if (!Number.isFinite(value))
        throw new TypeError("canonicalJson: non-finite number")
      return JSON.stringify(value)
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((item: unknown) => {
            if (item === undefined)
              throw new TypeError("canonicalJson: undefined array element")
            return canonicalJson(item)
          })
          .join(",")}]`
      }
      const proto: unknown = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("canonicalJson: only plain objects are allowed")
      }
      const entries = Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`)
  }
}

/** The bytes the receipt signature hashes: tool, version and validated input. */
export function signaturePayload(
  tool: string,
  toolVersion: string,
  input: unknown
): string {
  return canonicalJson({ input, tool, tool_version: toolVersion })
}
