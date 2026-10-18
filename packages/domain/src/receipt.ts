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

/** ISO-8601 UTC with nine fractional digits, as remote Parquet times are pinned. */
const nanoInstantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/)

/**
 * Provenance of a run over remote files (LOG-35, D4): which allowlisted
 * files were read on which path, with their load-time pins, the index
 * snapshot for the reference window, and what is known about bytes read.
 * Bytes are not instrumented on a normal query (only EXPLAIN ANALYZE shows
 * them), so they are `not_measured`; the footer figure is an estimate.
 */
const remoteParquetSourceSchema = z
  .strictObject({
    dataset: datasetSchema,
    kind: z.literal("remote_parquet"),
    path: z
      .enum(["indexed_window", "direct_scan"])
      .describe(
        "indexed_window: the inverted index over the reference window; direct_scan: read_parquet over the HTTPS files."
      ),
    window: z
      .strictObject({ from: instantSchema, to: instantSchema })
      .describe("Queried window [from, to), UTC."),
    files: z
      .array(
        z.strictObject({
          file_index: z.number().int().nonnegative(),
          url: z.string(),
          bytes: z.number().int().nonnegative(),
          etag: z
            .string()
            .nullable()
            .describe("ETag of the load-time HEAD; null for local fixtures."),
          last_modified: z
            .string()
            .describe("Last-Modified as read_blob reported it at load."),
          assigned_from: nanoInstantSchema.describe(
            "Start of the file's half-open assigned range [ts_min(n), ts_min(n+1))."
          ),
          assigned_to: nanoInstantSchema
            .nullable()
            .describe(
              "Exclusive end of the assigned range; null for the last file (ends with its last row)."
            ),
          read_from: nanoInstantSchema.describe(
            "Lower bound applied to this file, inclusive."
          ),
          read_to: nanoInstantSchema.describe(
            "Upper bound applied to this file, exclusive."
          ),
        })
      )
      .min(1),
    mapping_version: z
      .string()
      .describe("Column mapping of the remote files (load_manifest)."),
    index: z
      .strictObject({
        name: z.string(),
        glob: z.string(),
        from: instantSchema,
        to: instantSchema,
        built_at: instantSchema,
        build_ms: z.number().nonnegative(),
      })
      .nullable()
      .describe(
        "Index snapshot of the reference window (freshness); null for direct scans."
      ),
    source_check: z
      .strictObject({
        method: z.literal("read_blob size and last_modified"),
        files_checked: z.number().int().positive(),
      })
      .describe(
        "Check before the query that every file still matches its pin."
      ),
    bytes_read: z
      .strictObject({ kind: z.literal("not_measured"), reason: z.string() })
      .describe("Remote bytes are not instrumented on a normal query."),
    bytes_estimated_from_footer: z
      .strictObject({
        kind: z.literal("estimate"),
        bytes: z.number().int().nonnegative(),
        row_groups: z.number().int().nonnegative(),
        basis: z.string(),
      })
      .nullable()
      .describe(
        "Upper-bound estimate from Parquet footers, labelled as such; null for the indexed path."
      ),
  })
  .describe("Remote Parquet source of the run (otel).")

/**
 * Provenance of a run over the OTLP replay (LOG-35, D7): which replay of
 * which committed fixture the run read, through which listener table and
 * index snapshot.
 */
const otlpReplaySourceSchema = z
  .strictObject({
    dataset: datasetSchema,
    kind: z.literal("otlp_replay"),
    replay_id: z.string().describe("ID of the replay this load posted."),
    replayed_at: instantSchema.describe(
      "When the fixture was posted; the observed_timestamp of every record."
    ),
    records: z.number().int().nonnegative(),
    fixture: z.strictObject({
      path: z.string(),
      sha256: z.string(),
      source_url: z
        .string()
        .describe("text_bench file the records were selected from."),
    }),
    listener_table: z
      .string()
      .describe("SereneDB OTel table the listener wrote into."),
    index: z.strictObject({
      name: z.string(),
      built_at: instantSchema.describe(
        "When the index snapshot was built; later exports are not in it."
      ),
    }),
  })
  .describe("OTLP replay source of the run (otel_replay).")

export const receiptSourceSchema = z
  .discriminatedUnion("kind", [
    remoteParquetSourceSchema,
    otlpReplaySourceSchema,
  ])
  .describe("Source of the run; only for datasets outside log_events.")

export type ReceiptSource = z.infer<typeof receiptSourceSchema>

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
  source: receiptSourceSchema.optional(),
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
    source: true,
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
