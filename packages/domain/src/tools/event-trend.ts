import { z } from "zod"

import { formatFactValue, type Fact } from "../facts.ts"
import {
  datasetsWithColumn,
  SPECIFIC_DIMENSION_COLUMNS,
  type Dataset,
} from "../datasets.ts"
import { datasetSchema, pickFilter } from "../filters.ts"
import { bucketUnitSchema, instantSchema } from "../time.ts"
import type { ToolResult } from "../tool.ts"

/**
 * Contract of event_trend (technical.md § 8.2, concept A-08): log events per
 * UTC bucket for exactly one dataset, optionally split into at most five
 * series plus `other`. Buckets inside the data span without an event are
 * observed zeros; buckets outside it are not listed (R-03).
 */

/** Buckets per call (§ 8.2); more fail with limit_exceeded and a coarser bucket. */
export const TREND_MAX_BUCKETS = 120
/** Named series per call; the remaining values form `other` (A-08.1). */
export const TREND_MAX_SERIES = 5

export const TREND_FILTER = pickFilter([
  "from",
  "to",
  "components",
  "teams",
  "levels",
  "node",
  "rack",
  "alert_label",
  "only_errors",
  "only_alerts",
  "block_id",
  "host",
  "process_id",
  "client_ip",
  "thread",
  "pattern_id",
  "text",
])

/** A-08.3: a trend over both datasets on one time axis is rejected. */
export const NO_SHARED_TIME_AXIS =
  "No two datasets share a time axis; call event_trend once per dataset (see describe_corpus for the loaded datasets)."

/**
 * Dimensions a trend can be split by. `dataset` is fixed per call;
 * `http_status` and `endpoint` count API accesses, a different unit (R-01),
 * and belong to latency_stats and count_events.
 */
export const TREND_DIMENSIONS = [
  "team",
  "component",
  "level",
  "alert_label",
  "rack",
  "node",
  "host",
  "client_ip",
  "thread",
  "block_id",
  "pattern",
] as const

export const trendDimensionSchema = z
  .enum(TREND_DIMENSIONS)
  .describe(
    "Dimension that splits the trend into series: team (fictional ownership, unmapped = unowned), component, level, alert_label (BGL only, dataset label), rack (BGL only), node (BGL only), host (OpenSSH, Linux), client_ip (OpenSSH, Apache), thread (ZooKeeper), block_id (HDFS), pattern (pattern_id)."
  )

export type TrendDimension = z.infer<typeof trendDimensionSchema>

/**
 * Datasets a split dimension applies to (catalog, U26); null for the
 * dimensions every dataset has.
 */
export function trendDimensionDatasets(
  dimension: TrendDimension
): Dataset[] | null {
  switch (dimension) {
    case "alert_label":
    case "rack":
    case "node":
    case "host":
    case "client_ip":
    case "thread":
    case "block_id":
      return datasetsWithColumn(SPECIFIC_DIMENSION_COLUMNS[dimension])
    case "team":
    case "component":
    case "level":
    case "pattern":
      return null
  }
}

export const eventTrendInputSchema = z.strictObject({
  dataset: z
    .enum(datasetSchema.options, { error: NO_SHARED_TIME_AXIS })
    .describe(
      "Required, exactly one dataset. No two datasets share a time axis, so a trend is always per dataset; call once per dataset."
    ),
  bucket: bucketUnitSchema.describe(
    "Bucket size in UTC: hour, day or week (weeks start on Monday 00:00 UTC). Each bucket is [start, start + 1 unit)."
  ),
  ...TREND_FILTER.shape,
  split_by: trendDimensionSchema
    .optional()
    .describe(
      `Optional, one dimension: the ${TREND_MAX_SERIES} values with the most events in scope become series (ties by value), all others are summed as other. Without split_by only the bucket totals are returned.`
    ),
})

export type EventTrendInput = z.infer<typeof eventTrendInputSchema>

const count = z.number().int().nonnegative()

const seriesValue = (dimension: TrendDimension) =>
  z
    .string()
    .nullable()
    .optional()
    .describe(
      `Value of ${dimension} when the trend is split by it; null is its own category (field empty, e.g. no alert label).`
    )

/**
 * One series: the split dimension as its only key besides `events`, e.g.
 * `{ component: "KERNEL", events: 12 }`, so facts carry the group
 * `{ component }` like count_events.
 */
export const trendSeriesSchema = z.strictObject({
  team: seriesValue("team"),
  component: seriesValue("component"),
  level: seriesValue("level"),
  alert_label: seriesValue("alert_label"),
  rack: seriesValue("rack"),
  node: seriesValue("node"),
  host: seriesValue("host"),
  client_ip: seriesValue("client_ip"),
  thread: seriesValue("thread"),
  block_id: seriesValue("block_id"),
  pattern: seriesValue("pattern"),
  events: count.describe("Log events of this series."),
})

export type TrendSeries = z.infer<typeof trendSeriesSchema>

export const trendBucketSchema = z.strictObject({
  bucket_start: instantSchema.describe("Bucket start, UTC, inclusive."),
  bucket_end: instantSchema.describe("Bucket end, UTC, exclusive."),
  partial: z
    .boolean()
    .describe(
      "The window or the data span starts or ends inside this bucket, so it covers less than a full unit; a lower count here is no drop."
    ),
  capture_gap: z
    .boolean()
    .describe(
      "The dataset has no event at all in this bucket (any filter): no data was captured, so its zero is not observed calm."
    ),
  events: count.describe("Log events in scope in this bucket, all series."),
  series: z
    .array(trendSeriesSchema)
    .max(TREND_MAX_SERIES)
    .describe("Events per series in this bucket, in the order of series."),
  other_events: count
    .nullable()
    .describe(
      "Events of all other values in this bucket; null when there is no other series."
    ),
})

export type TrendBucket = z.infer<typeof trendBucketSchema>

export const eventTrendOutputSchema = z.strictObject({
  dataset: datasetSchema,
  bucket: bucketUnitSchema,
  split_by: trendDimensionSchema.nullable(),
  data_span: z
    .strictObject({
      first: instantSchema.describe("First event of the dataset, UTC."),
      last: instantSchema.describe("Last event of the dataset, UTC."),
    })
    .describe("Observed span of the whole dataset, before any filter."),
  effective_range: z
    .strictObject({
      from: instantSchema.describe("Start, inclusive."),
      to: instantSchema.describe("End, exclusive."),
    })
    .nullable()
    .describe(
      "Intersection of the requested window and the data span: the time the buckets cover. null when the window lies outside the data span."
    ),
  bucket_count: count.describe("Number of buckets returned."),
  total: count
    .nullable()
    .describe(
      "Log events in scope over the effective range; null when the window lies outside the data span (no data is not zero)."
    ),
  series: z
    .array(trendSeriesSchema)
    .max(TREND_MAX_SERIES)
    .describe(
      "Series with their events in scope, by events descending, then value; empty without split_by."
    ),
  other: z
    .strictObject({
      events: count.describe("Events of all values outside the series."),
      merged_values: count.describe("Number of values summed as other."),
    })
    .nullable()
    .describe(
      `Values beyond the top ${TREND_MAX_SERIES}; null when there are none.`
    ),
  buckets: z
    .array(trendBucketSchema)
    .max(TREND_MAX_BUCKETS)
    .describe("Every bucket of the effective range by bucket_start."),
})

export type EventTrendOutput = z.infer<typeof eventTrendOutputSchema>

/** The value of a series under the split dimension. */
export function seriesValueOf(
  series: TrendSeries,
  dimension: TrendDimension
): string | null {
  return series[dimension] ?? null
}

/**
 * Short text for clients without structured output (MCP text block, § 9):
 * totals and every bucket with their fact IDs, flags and the receipt.
 */
export function summarizeEventTrend(
  result: ToolResult<EventTrendOutput>
): string {
  const { data, facts, receipt, notes } = result
  const byPath = new Map<string, Fact>(facts.map((fact) => [fact.path, fact]))
  const cite = (path: string) => {
    const fact = byPath.get(path)
    return fact === undefined ? "" : ` [${fact.id}]`
  }
  const dimension = data.split_by
  const label = (series: TrendSeries) =>
    dimension === null ? "" : JSON.stringify(seriesValueOf(series, dimension))
  const range =
    data.effective_range === null
      ? "outside the data span"
      : `[${data.effective_range.from}, ${data.effective_range.to})`

  const lines = [
    `event_trend ${data.dataset} by ${data.bucket}${dimension === null ? "" : `, split by ${dimension}`} · receipt ${receipt.receipt_id}`,
    `Data span ${data.data_span.first} – ${data.data_span.last}; effective range ${range}; ${data.bucket_count} bucket(s) (UTC).`,
    data.total === null
      ? "No log events counted: the window lies outside the data span."
      : `${formatFactValue(data.total)} log events in scope${cite("/result/total")}.`,
  ]
  if (dimension !== null && data.series.length > 0) {
    const parts = data.series.map(
      (series, index) =>
        `${label(series)} ${formatFactValue(series.events)}${cite(`/result/series/${index}/events`)}`
    )
    if (data.other !== null) {
      parts.push(
        `other (${data.other.merged_values} values) ${formatFactValue(data.other.events)}${cite("/result/other/events")}`
      )
    }
    lines.push(`Series: ${parts.join(" · ")}`)
  }
  data.buckets.forEach((bucket, index) => {
    const base = `/result/buckets/${index}`
    const flags = [
      bucket.partial ? "partial" : null,
      bucket.capture_gap ? "capture gap" : null,
    ].filter((flag): flag is string => flag !== null)
    const cells = bucket.series.map(
      (series, cell) =>
        `${label(series)} ${formatFactValue(series.events)}${cite(`${base}/series/${cell}/events`)}`
    )
    if (bucket.other_events !== null)
      cells.push(
        `other ${formatFactValue(bucket.other_events)}${cite(`${base}/other_events`)}`
      )
    lines.push(
      `${bucket.bucket_start} ${formatFactValue(bucket.events)}${cite(`${base}/events`)}${cells.length === 0 ? "" : ` (${cells.join(", ")})`}${flags.length === 0 ? "" : ` [${flags.join(", ")}]`}`
    )
  })
  lines.push(...notes.map((note) => `Note: ${note}`))
  return lines.join("\n")
}
