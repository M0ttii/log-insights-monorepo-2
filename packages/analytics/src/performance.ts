import { createHash } from "node:crypto"
import { open, readdir } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { receiptSchema } from "@workspace/domain/receipt"
import { instantSchema, parseInstant } from "@workspace/domain/time"
import type { QueryRunner } from "@workspace/domain/tool"
import { z } from "zod"

import { exactCount, isoTime } from "./sql.ts"
import { receiptSignature, resultDigest } from "./receipts.ts"

const RECEIPT_FILE = /^r_[0-9a-f]{8}\.json$/
const MAX_FILE_BYTES = 4 * 1024 * 1024
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const durationSchema = z.number().finite().nonnegative()
const absolutePath = z
  .string()
  .min(1)
  .refine(isAbsolute)
  .refine((value) => !value.includes("\0"))
const preciseInstant = instantSchema.refine(
  (value) => parseInstant(value) !== null
)

export const performanceOptionsSchema = z
  .strictObject({
    receipts_dir: absolutePath,
    database_receipts_dir: z
      .literal("/data/receipts")
      .default("/data/receipts"),
    from: preciseInstant.optional(),
    to: preciseInstant.optional(),
    max_receipts: z.number().int().min(1).max(10_000).default(10_000),
    max_groups: z.number().int().min(1).max(1000).default(200),
  })
  .refine(
    (value) => {
      if (value.from === undefined || value.to === undefined) return true
      const from = parseInstant(value.from)
      const to = parseInstant(value.to)
      return from !== null && to !== null && from < to
    },
    { message: "from must precede to", path: ["to"] }
  )

type PerformanceOptions = z.infer<typeof performanceOptionsSchema>

const dateWindowSchema = z.strictObject({
  first_created_at: preciseInstant,
  last_created_at: preciseInstant,
})

const sourceSchema = z.strictObject({
  receipt_id: receiptSchema.shape.receipt_id,
  filename: z.string().regex(RECEIPT_FILE),
  sha256: hashSchema,
  signature: hashSchema,
  result_digest: hashSchema,
})

const performanceGroupSchema = z.strictObject({
  data_version: z.string().min(1),
  tool: z.string(),
  tool_version: z.string(),
  client: receiptSchema.shape.client,
  n: z.number().int().positive().safe(),
  median_ms: durationSchema,
  p95_ms: durationSchema,
  min_ms: durationSchema,
  max_ms: durationSchema,
  date_window: dateWindowSchema,
})

const performanceReportSchema = z.strictObject({
  schema_version: z.literal(1),
  status: z.enum(["measured", "not_measured"]),
  reason: z.enum(["no_source_receipts", "no_receipts_in_window"]).nullable(),
  options: z.strictObject({
    database_receipts_dir: z.literal("/data/receipts"),
    from: preciseInstant.optional(),
    to: preciseInstant.optional(),
    max_receipts: z.number().int().min(1).max(10_000),
    max_groups: z.number().int().min(1).max(1000),
  }),
  measurement: z.literal(
    "Sum of database round trips per successful persisted receipt, in milliseconds."
  ),
  caveats: z.array(z.string()),
  n: z.number().int().nonnegative().safe().nullable(),
  date_window: dateWindowSchema.nullable(),
  sources: z.array(sourceSchema).max(10_000),
  queries: z.array(
    z.strictObject({ sql: z.string(), params: z.array(z.json()) })
  ),
  groups: z.array(performanceGroupSchema).max(1000),
})

export type PerformanceReport = z.infer<typeof performanceReportSchema>

const CAVEATS = [
  "duration_ms sums pg database round trips, including network time; it is neither engine CPU time nor end-to-end investigation latency.",
  "This is a retrospective summary of successful persisted receipts, not a controlled benchmark; failures without receipts are absent and cache state, concurrency and machine load are unknown.",
  "Groups separate data version, tool, tool version and client; scopes and query signatures can still differ within a group, so groups are not directly comparable workloads.",
  "The date window refers to receipt creation times, not corpus event times; filters include from and exclude to.",
  "Continuous sample p95 is descriptive even for small n; no tail-latency or performance guarantee follows from it.",
  "Only canonical r_XXXXXXXX.json receipt files are selected; temporary and unrelated files are excluded. File hashes bind the exact source bytes for replay.",
]

/**
 * Gate G7 follow-up: a bound filename yields PostgreSQL unknown OID 705 even
 * with explicit columns. The fixed Compose mount is therefore structural SQL;
 * every selected receipt ID and time bound remains a parameter. The exact glob
 * excludes temporary files and names that the local snapshot did not accept.
 * Metadata columns avoid inferring heterogeneous inputs, results and log text.
 */
const PERFORMANCE_SQL = `WITH source AS (
  SELECT receipt_id, created_at, signature, result_digest, data_version,
         tool, tool_version, client, duration_ms
  FROM read_json('/data/receipts/r_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].json', union_by_name = true, columns = {
    receipt_id: 'VARCHAR', created_at: 'TIMESTAMPTZ', signature: 'VARCHAR',
    result_digest: 'VARCHAR', data_version: 'VARCHAR', tool: 'VARCHAR',
    tool_version: 'VARCHAR', client: 'VARCHAR', duration_ms: 'DOUBLE'
  })
  WHERE receipt_id = ANY($1::VARCHAR[])
), filtered AS (
  SELECT * FROM source
  WHERE ($2::TIMESTAMPTZ IS NULL OR created_at >= $2::TIMESTAMPTZ)
    AND ($3::TIMESTAMPTZ IS NULL OR created_at < $3::TIMESTAMPTZ)
), grouped AS (
  SELECT data_version, tool, tool_version, client,
         count(*) AS group_n, median(duration_ms) AS median_ms,
         quantile_cont(duration_ms, 0.95) AS p95_ms,
         min(duration_ms) AS min_ms, max(duration_ms) AS max_ms,
         min(created_at) AS group_first_created_at,
         max(created_at) AS group_last_created_at
  FROM filtered
  GROUP BY data_version, tool, tool_version, client
), summary AS (
  SELECT count(*) AS n, (SELECT count(*) FROM grouped) AS group_count,
         min(created_at) AS first_created_at, max(created_at) AS last_created_at
  FROM filtered
)
SELECT summary.n, summary.group_count,
       ${isoTime("summary.first_created_at")} AS first_created_at,
       ${isoTime("summary.last_created_at")} AS last_created_at,
       filtered.receipt_id,
       ${isoTime("filtered.created_at")} AS source_created_at,
       filtered.signature, filtered.result_digest, filtered.duration_ms,
       filtered.data_version, filtered.tool, filtered.tool_version, filtered.client,
       grouped.group_n, grouped.median_ms, grouped.p95_ms, grouped.min_ms, grouped.max_ms,
       ${isoTime("grouped.group_first_created_at")} AS group_first_created_at,
       ${isoTime("grouped.group_last_created_at")} AS group_last_created_at
FROM summary
LEFT JOIN filtered ON true
LEFT JOIN grouped ON filtered.data_version = grouped.data_version
  AND filtered.tool = grouped.tool AND filtered.tool_version = grouped.tool_version
  AND filtered.client = grouped.client
ORDER BY data_version, tool, tool_version, client, receipt_id`

const summarySchema = z.object({
  n: exactCount,
  group_count: exactCount,
  first_created_at: preciseInstant.nullable(),
  last_created_at: preciseInstant.nullable(),
})

const rowSchema = summarySchema.extend({
  receipt_id: receiptSchema.shape.receipt_id,
  source_created_at: preciseInstant,
  signature: hashSchema,
  result_digest: hashSchema,
  duration_ms: durationSchema,
  data_version: z.string().min(1),
  tool: z.string(),
  tool_version: z.string(),
  client: receiptSchema.shape.client,
  group_n: exactCount,
  median_ms: durationSchema,
  p95_ms: durationSchema,
  min_ms: durationSchema,
  max_ms: durationSchema,
  group_first_created_at: preciseInstant,
  group_last_created_at: preciseInstant,
})

const metadataSchema = receiptSchema
  .pick({
    receipt_id: true,
    created_at: true,
    signature: true,
    result_digest: true,
    data_version: true,
    tool: true,
    tool_version: true,
    client: true,
    duration_ms: true,
  })
  .strip()

type Metadata = z.infer<typeof metadataSchema>
type Snapshot = { source: z.infer<typeof sourceSchema>; receipt: Metadata }

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

/** Bound allocation even when a source grows between validation and reading. */
async function readReceipt(file: string, signal: AbortSignal): Promise<Buffer> {
  const handle = await open(file, "r")
  try {
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        null
      )
      if (bytesRead === 0) break
      size += bytesRead
    }
    if (size > MAX_FILE_BYTES) throw new Error("receipt too large")
    return buffer.subarray(0, size)
  } finally {
    await handle.close()
  }
}

async function snapshots(
  options: PerformanceOptions,
  signal: AbortSignal
): Promise<Snapshot[]> {
  let filenames: string[]
  try {
    filenames = (await readdir(options.receipts_dir))
      .filter((file) => RECEIPT_FILE.test(file))
      .toSorted()
  } catch (error) {
    if (isMissing(error)) return []
    throw new Error("Cannot read receipt directory", { cause: error })
  }
  if (filenames.length > options.max_receipts)
    throw new Error("Receipt limit exceeded; narrow the source directory")
  const result: Snapshot[] = []
  for (const filename of filenames) {
    signal.throwIfAborted()
    const file = join(options.receipts_dir, filename)
    try {
      const bytes = await readReceipt(file, signal)
      const receipt = receiptSchema.parse(JSON.parse(bytes.toString("utf8")))
      if (`${receipt.receipt_id}.json` !== filename)
        throw new Error("receipt filename mismatch")
      if (
        receipt.signature !==
          receiptSignature(receipt.tool, receipt.tool_version, receipt.input) ||
        receipt.result_digest !== resultDigest(receipt.result)
      )
        throw new Error("receipt digest mismatch")
      result.push({
        source: {
          receipt_id: receipt.receipt_id,
          filename,
          sha256: sha256(bytes),
          signature: receipt.signature,
          result_digest: receipt.result_digest,
        },
        // Retain only metadata: 10,000 full results could occupy gigabytes.
        receipt: metadataSchema.parse(receipt),
      })
    } catch {
      signal.throwIfAborted()
      throw new Error(`Invalid receipt ${filename}`)
    }
  }
  return result
}

function matchesWindow(
  receipt: Metadata,
  options: PerformanceOptions
): boolean {
  const created = parseInstant(receipt.created_at)
  const from = options.from === undefined ? null : parseInstant(options.from)
  const to = options.to === undefined ? null : parseInstant(options.to)
  return (
    created !== null &&
    (from === null || created >= from) &&
    (to === null || created < to)
  )
}

/**
 * Read-only SQL over an explicitly bounded file snapshot. The normal analytics
 * pool supplies UTC sessions, cancellation and its 10-second server timeout.
 * Local parsing/hashing validates provenance; every statistic comes from SQL.
 */
export async function runPerformanceReport(
  db: QueryRunner,
  rawOptions: unknown,
  signal: AbortSignal = new AbortController().signal
): Promise<PerformanceReport> {
  const options = performanceOptionsSchema.parse(rawOptions)
  signal.throwIfAborted()
  const files = await snapshots(options, signal)
  const report: PerformanceReport = {
    schema_version: 1,
    status: "not_measured",
    reason: "no_source_receipts",
    options: {
      database_receipts_dir: options.database_receipts_dir,
      from: options.from,
      to: options.to,
      max_receipts: options.max_receipts,
      max_groups: options.max_groups,
    },
    measurement:
      "Sum of database round trips per successful persisted receipt, in milliseconds.",
    caveats: CAVEATS,
    n: null,
    date_window: null,
    sources: files.map((file) => file.source),
    queries: [],
    groups: [],
  }
  if (files.length === 0) return performanceReportSchema.parse(report)
  const receiptIds = files.map((file) => file.source.receipt_id)
  const params = [receiptIds, options.from ?? null, options.to ?? null]
  report.queries.push({ sql: PERFORMANCE_SQL, params })
  const { rows } = await db.query(PERFORMANCE_SQL, params, signal)
  const first = rows[0]
  if (first === undefined) throw new Error("Missing performance summary")
  const summary = summarySchema.parse(first)
  if (summary.group_count > options.max_groups)
    throw new Error(
      "Group limit exceeded; narrow the source directory or date window"
    )
  if (rows.length > options.max_receipts)
    throw new Error("Database source limit exceeded")
  report.n = summary.n
  report.reason = "no_receipts_in_window"
  if (summary.n > 0) {
    report.status = "measured"
    report.reason = null
    report.date_window = dateWindowSchema.parse({
      first_created_at: summary.first_created_at,
      last_created_at: summary.last_created_at,
    })
  }
  const expected = new Map(
    files
      .filter((file) => matchesWindow(file.receipt, options))
      .map((file) => [file.source.receipt_id, file.receipt])
  )
  const seen = new Set<string>()
  const groups = new Map<string, z.infer<typeof performanceGroupSchema>>()
  for (const value of rows) {
    if (summary.n === 0) {
      if (
        rows.length !== 1 ||
        value.receipt_id !== null ||
        expected.size !== 0 ||
        summary.group_count !== 0
      )
        throw new Error("Database source does not match local snapshot")
      continue
    }
    const row = rowSchema.parse(value)
    const receipt = expected.get(row.receipt_id)
    if (seen.has(row.receipt_id)) throw new Error("Duplicate database receipt")
    if (
      receipt === undefined ||
      row.n !== summary.n ||
      row.group_count !== summary.group_count ||
      row.signature !== receipt.signature ||
      row.result_digest !== receipt.result_digest ||
      row.duration_ms !== receipt.duration_ms ||
      row.data_version !== receipt.data_version ||
      row.tool !== receipt.tool ||
      row.tool_version !== receipt.tool_version ||
      row.client !== receipt.client ||
      parseInstant(row.source_created_at) !== parseInstant(receipt.created_at)
    )
      throw new Error("Database source does not match local snapshot")
    seen.add(row.receipt_id)
    const group = performanceGroupSchema.parse({
      data_version: row.data_version,
      tool: row.tool,
      tool_version: row.tool_version,
      client: row.client,
      n: row.group_n,
      median_ms: row.median_ms,
      p95_ms: row.p95_ms,
      min_ms: row.min_ms,
      max_ms: row.max_ms,
      date_window: {
        first_created_at: row.group_first_created_at,
        last_created_at: row.group_last_created_at,
      },
    })
    const key = JSON.stringify([
      group.data_version,
      group.tool,
      group.tool_version,
      group.client,
    ])
    const previous = groups.get(key)
    if (
      previous !== undefined &&
      JSON.stringify(previous) !== JSON.stringify(group)
    )
      throw new Error("Inconsistent database group")
    groups.set(key, group)
  }
  if (
    seen.size !== expected.size ||
    seen.size !== summary.n ||
    groups.size !== summary.group_count
  )
    throw new Error("Database source does not match local snapshot")
  report.groups = [...groups.values()]
  for (const file of files) {
    signal.throwIfAborted()
    let bytes: Uint8Array
    try {
      bytes = await readReceipt(
        join(options.receipts_dir, file.source.filename),
        signal
      )
    } catch {
      signal.throwIfAborted()
      throw new Error("Receipt changed during report")
    }
    if (sha256(bytes) !== file.source.sha256)
      throw new Error("Receipt changed during report")
  }
  return performanceReportSchema.parse(report)
}
