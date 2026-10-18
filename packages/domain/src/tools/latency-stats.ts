import { z } from "zod"

import { formatFactValue, type Fact, type FactSpec } from "../facts.ts"
import { pickFilter } from "../filters.ts"
import { instantSchema } from "../time.ts"
import type { ToolResult } from "../tool.ts"

/**
 * Contract of latency_stats (technical.md § 8.2, concept A-12, R-01, R-02,
 * O-06): latency percentiles and 4xx/5xx rates of OpenStack API accesses,
 * overall or per endpoint, method, status, component or UTC bucket. Every
 * number comes from SereneDB; rates name numerator and denominator as
 * separate fields, and a missing 5xx is an observed zero with denominator.
 */

export const LATENCY_MAX_TOP_N = 20
export const LATENCY_DEFAULT_TOP_N = 10
/** Time buckets per call; every bucket of the effective range is listed. */
export const LATENCY_MAX_BUCKETS = 120
/** quantile_cont in list form, one call per row (gate G5). */
export const LATENCY_PERCENTILES = [0.5, 0.9, 0.95, 0.99] as const

export const LATENCY_FILTER = pickFilter([
  "from",
  "to",
  "components",
  "request_id",
  "endpoints",
  "http_status",
])

export const OPENSTACK_ONLY =
  "latency_stats covers OpenStack API accesses only: no other dataset has HTTP access lines with durations (the Apache file is an error log without access lines). Use dataset openstack or leave it out; for error frequencies in other datasets use count_events."

export const LATENCY_GROUPS = [
  "endpoint",
  "method",
  "status",
  "component",
  "hour",
  "day",
] as const

export const latencyGroupSchema = z
  .enum(LATENCY_GROUPS)
  .describe(
    "Grouping: endpoint (API path with IDs masked), method (HTTP method), status (HTTP status code), component (logging service), hour or day (UTC buckets [start, start + 1 unit), listed in time order)."
  )

export type LatencyGroup = z.infer<typeof latencyGroupSchema>

export const TIME_GROUPS: readonly LatencyGroup[] = ["hour", "day"]

export function isTimeGroup(group: LatencyGroup | undefined): boolean {
  return group !== undefined && TIME_GROUPS.includes(group)
}

/** Row key of a grouping: the group_by name, `bucket_start` for time buckets. */
export function groupKeyOf(group: LatencyGroup): string {
  return isTimeGroup(group) ? "bucket_start" : group
}

export const latencyOutlierInputSchema = z
  .strictObject({
    threshold: z.enum(["p95", "p99"]).default("p95"),
    min_baseline: z.number().int().min(2).max(10000).default(20),
    case_event_id: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .describe(
    "SQL percentile threshold over every latency value in the identical filtered window. Below min_baseline the threshold and decisions are unknown. case_event_id checks an existing event only within this scope; otherwise show at most 20 slowest accesses."
  )

export const latencyStatsInputSchema = z.strictObject({
  outliers: latencyOutlierInputSchema.optional(),
  dataset: z
    .enum(["openstack"], { error: OPENSTACK_ONLY })
    .optional()
    .describe(
      "Optional, only openstack: API accesses exist in OpenStack only. Default: openstack."
    ),
  ...LATENCY_FILTER.shape,
  group_by: latencyGroupSchema
    .optional()
    .describe(
      "Optional, one grouping: endpoint, method, status, component, hour or day. Without it only the total row is returned."
    ),
  top_n: z
    .number()
    .int()
    .min(1)
    .max(LATENCY_MAX_TOP_N)
    .optional()
    .describe(
      `Groups to list for endpoint, method, status or component (1–${LATENCY_MAX_TOP_N}), most API accesses first. Default: ${LATENCY_DEFAULT_TOP_N}. The rest is aggregated as other. Not allowed with hour, day or without group_by: every bucket is listed.`
    ),
})

export type LatencyStatsInput = z.infer<typeof latencyStatsInputSchema>

const count = z.number().int().nonnegative()
const ratio = z.number().min(0).max(1)
const latency = (percentile: string) =>
  z
    .number()
    .nonnegative()
    .nullable()
    .describe(
      `${percentile} latency in milliseconds over latency_values, continuous (linear interpolation, quantile_cont); null without a latency value.`
    )

/** The numbers of one row: the total, a group or other. */
const statsShape = {
  api_access_events: count.describe(
    "API accesses: OpenStack lines with an HTTP status, with or without request ID (R-01). Denominator of rate_5xx and rate_4xx."
  ),
  without_request_id: count.describe(
    "API accesses without request ID (part of api_access_events)."
  ),
  unique_requests: count.describe(
    "Distinct request IDs (a separate counting unit, R-01); accesses without request ID are not counted."
  ),
  latency_values: count.describe(
    "API accesses with a latency; the percentiles are computed over these."
  ),
  p50_ms: latency("Median (p50)"),
  p90_ms: latency("p90"),
  p95_ms: latency("p95"),
  p99_ms: latency("p99"),
  max_ms: z
    .number()
    .nonnegative()
    .nullable()
    .describe("Highest latency in milliseconds; null without a latency value."),
  errors_5xx: count.describe(
    "API accesses with status 500–599 (failed accesses, R-02). Numerator of rate_5xx."
  ),
  rate_5xx: ratio
    .nullable()
    .describe(
      "errors_5xx / api_access_events as a fraction (0–1), computed in SereneDB. 0 is an observed zero over api_access_events; null when api_access_events is 0."
    ),
  errors_4xx: count.describe(
    "API accesses with status 400–499 (client errors, not failed accesses, R-02). Numerator of rate_4xx."
  ),
  rate_4xx: ratio
    .nullable()
    .describe(
      "errors_4xx / api_access_events as a fraction (0–1), computed in SereneDB; null when api_access_events is 0."
    ),
}

export const latencyStatsRowSchema = z.strictObject(statsShape)

export type LatencyStatsRow = z.infer<typeof latencyStatsRowSchema>

/** One group: exactly its key field (by group_by) plus the numbers. */
export const latencyGroupRowSchema = z.strictObject({
  endpoint: z.string().optional().describe("API path with IDs masked."),
  method: z.string().optional().describe("HTTP method."),
  status: z.number().int().optional().describe("HTTP status code."),
  component: z.string().optional().describe("Service that logged the access."),
  bucket_start: instantSchema
    .optional()
    .describe("With hour or day: bucket start, UTC, inclusive."),
  bucket_end: instantSchema
    .optional()
    .describe("With hour or day: bucket end, UTC, exclusive."),
  partial: z
    .boolean()
    .optional()
    .describe(
      "With hour or day: the window or the data span starts or ends inside this bucket, so it covers less than a full unit."
    ),
  capture_gap: z
    .boolean()
    .optional()
    .describe(
      "With hour or day: OpenStack has no log event at all in this bucket; its zero is missing data, not observed calm."
    ),
  ...statsShape,
})

export type LatencyGroupRow = z.infer<typeof latencyGroupRowSchema>

export const latencyOutlierOutputSchema = z.strictObject({
  baseline_values: count,
  minimum_baseline: count,
  threshold_ms: z.number().nonnegative().nullable(),
  threshold: z.enum(["p95", "p99"]),
  determinable: z.boolean(),
  outlier_events: count
    .nullable()
    .describe(
      "Strict exceedances; null when the baseline is too small to decide."
    ),
  rate: ratio
    .nullable()
    .describe(
      "Outlier API accesses / baseline_values; null when below minimum baseline."
    ),
  cases: z
    .array(
      z.strictObject({
        event_id: count,
        latency_ms: z.number().nonnegative(),
        request_id: z.string().nullable(),
        exceeds_threshold: z.boolean().nullable(),
      })
    )
    .max(20),
  case_found: z.boolean().nullable(),
  cases_truncated: z.boolean(),
})

export const latencyStatsOutputSchema = z.strictObject({
  outliers: latencyOutlierOutputSchema.optional(),
  dataset: z.literal("openstack"),
  unit: z
    .literal("api_accesses")
    .describe(
      "Counting unit of the counts and the denominator of every rate (R-01); unique_requests are requests."
    ),
  group_by: latencyGroupSchema.nullable(),
  data_span: z
    .strictObject({
      first: instantSchema.describe("First OpenStack event, UTC."),
      last: instantSchema.describe("Last OpenStack event, UTC."),
    })
    .describe("Observed span of the dataset, before any filter."),
  effective_range: z
    .strictObject({
      from: instantSchema.describe("Start, inclusive."),
      to: instantSchema.describe("End, exclusive."),
    })
    .nullable()
    .describe(
      "Window ∩ data span: the time the numbers cover; null when the window lies outside the data span (no data is not zero)."
    ),
  total: latencyStatsRowSchema.describe(
    "All API accesses in scope; the denominator of the total rates."
  ),
  group_count: count.describe(
    "Number of groups in scope (with hour or day: buckets listed); 0 without group_by."
  ),
  groups: z
    .array(latencyGroupRowSchema)
    .max(LATENCY_MAX_BUCKETS)
    .describe(
      "endpoint, method, status, component: at most top_n groups by api_access_events descending, then key ascending. hour, day: every bucket of the effective range in time order, empty buckets included."
    ),
  other: z
    .strictObject({
      groups: count.describe("Groups aggregated here."),
      ...statsShape,
    })
    .nullable()
    .describe(
      "The groups beyond top_n, aggregated over their accesses (percentiles over their latencies, not averaged); null when every group is listed."
    ),
  truncated: z
    .boolean()
    .describe("True when group_count is larger than the listed groups."),
  top_n: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe(
      "The top_n that applied; null with hour, day or without group_by."
    ),
})

export type LatencyStatsOutput = z.infer<typeof latencyStatsOutputSchema>

/** Fact metric and unit per number of a row (R-01 units). */
const STAT_FACTS: readonly [keyof LatencyStatsRow, string][] = [
  ["api_access_events", "api_accesses"],
  ["without_request_id", "api_accesses"],
  ["unique_requests", "requests"],
  ["latency_values", "api_accesses"],
  ["p50_ms", "ms"],
  ["p90_ms", "ms"],
  ["p95_ms", "ms"],
  ["p99_ms", "ms"],
  ["max_ms", "ms"],
  ["errors_5xx", "api_accesses"],
  ["rate_5xx", "ratio"],
  ["errors_4xx", "api_accesses"],
  ["rate_4xx", "ratio"],
]

function statFacts(
  path: string,
  groupKeys: string[],
  prefix: "" | "other_"
): FactSpec[] {
  return STAT_FACTS.map(([field, unit]) => ({
    path: `${path}/${field}`,
    metric: `${prefix}${field}`,
    unit,
    groupKeys,
  }))
}

function timeFact(path: string, metric: string, groupKeys: string[] = []) {
  return { path, metric, unit: "utc_time", groupKeys }
}

/**
 * Every number of the total, the groups and other; the metric is the field
 * name (other_ for other), the group of a group fact its key field.
 */
export function latencyStatsFactSpecs(
  input: Pick<LatencyStatsInput, "group_by">
): FactSpec[] {
  const grouped =
    input.group_by === undefined
      ? []
      : [
          ...statFacts("/result/groups/*", [groupKeyOf(input.group_by)], ""),
          ...statFacts("/result/other", [], "other_"),
          {
            path: "/result/other/groups",
            metric: "other_groups",
            unit: "groups",
            groupKeys: [],
          },
        ]
  return [
    ...(
      [
        "baseline_values",
        "minimum_baseline",
        "threshold_ms",
        "outlier_events",
        "rate",
      ] as const
    ).map((field) => ({
      path: `/result/outliers/${field}`,
      metric: `outlier_${field}`,
      unit:
        field === "threshold_ms"
          ? "ms"
          : field === "rate"
            ? "ratio"
            : "api_accesses",
      groupKeys: [],
    })),
    {
      path: "/result/outliers/cases/*/event_id",
      metric: "outlier_event_id",
      unit: "event_id",
      groupKeys: ["event_id"],
    },
    {
      path: "/result/outliers/cases/*/latency_ms",
      metric: "outlier_case_latency",
      unit: "ms",
      groupKeys: ["event_id"],
    },
    ...statFacts("/result/total", [], ""),
    {
      path: "/result/group_count",
      metric: "groups",
      unit: "groups",
      groupKeys: [],
    },
    ...grouped,
    timeFact("/result/data_span/first", "data_span_start"),
    timeFact("/result/data_span/last", "data_span_end"),
    timeFact("/result/effective_range/from", "range_start"),
    timeFact("/result/effective_range/to", "range_end"),
    timeFact("/scope/windows/*/from", "window_start", ["dataset"]),
    timeFact("/scope/windows/*/to", "window_end", ["dataset"]),
  ]
}

/**
 * Short text for clients without structured output (MCP text block, § 9):
 * the total and every group with fact IDs for counts, percentiles and
 * rates, then the notes. Group keys can be log-derived text, so they
 * appear as JSON literals.
 */
export function summarizeLatencyStats(
  result: ToolResult<LatencyStatsOutput>
): string {
  const { data, facts, receipt, notes } = result
  const byPath = new Map<string, Fact>(facts.map((fact) => [fact.path, fact]))
  const cite = (path: string) => {
    const fact = byPath.get(path)
    return fact === undefined ? "" : ` [${fact.id}]`
  }
  const row = (path: string, stats: LatencyStatsRow) => {
    const ms = (
      field: "p50_ms" | "p90_ms" | "p95_ms" | "p99_ms" | "max_ms"
    ) => {
      const value = stats[field]
      const label = field.slice(0, -3)
      return value === null
        ? `${label} n/a`
        : `${label} ${formatFactValue(round(value, 1))} ms${cite(`${path}/${field}`)}`
    }
    const rate = (kind: "5xx" | "4xx") => {
      const errors = stats[`errors_${kind}`]
      const value = stats[`rate_${kind}`]
      return `${kind} ${formatFactValue(errors)}${cite(`${path}/errors_${kind}`)} of ${formatFactValue(stats.api_access_events)} (${value === null ? "rate n/a" : `${formatFactValue(round(value * 100, 3))} %${cite(`${path}/rate_${kind}`)}`})`
    }
    return [
      `${formatFactValue(stats.api_access_events)} API accesses${cite(`${path}/api_access_events`)}, ${formatFactValue(stats.without_request_id)} without request ID${cite(`${path}/without_request_id`)}, ${formatFactValue(stats.unique_requests)} requests${cite(`${path}/unique_requests`)}`,
      [
        ms("p50_ms"),
        ms("p90_ms"),
        ms("p95_ms"),
        ms("p99_ms"),
        ms("max_ms"),
      ].join(", "),
      `${rate("5xx")}, ${rate("4xx")}`,
    ].join("; ")
  }
  const key = (group: LatencyGroupRow) => {
    const by = data.group_by
    if (by === null) return ""
    if (isTimeGroup(by))
      return `${group.bucket_start ?? ""}${group.partial === true ? " [partial]" : ""}${group.capture_gap === true ? " [capture gap]" : ""}`
    return `${by}=${JSON.stringify(groupValue(group, by))}`
  }
  const range =
    data.effective_range === null
      ? "outside the data span"
      : `[${data.effective_range.from}, ${data.effective_range.to})`
  const lines = [
    `latency_stats openstack${data.group_by === null ? "" : ` by ${data.group_by}`} · receipt ${receipt.receipt_id}`,
    `Effective range ${range} (UTC); ${data.groups.length} of ${formatFactValue(data.group_count)} group(s) shown, truncated: ${data.truncated}.`,
    `Total: ${row("/result/total", data.total)}.`,
    ...data.groups.map(
      (group, index) =>
        `${index + 1}. ${key(group)}: ${row(`/result/groups/${index}`, group)}`
    ),
    ...(data.other === null
      ? []
      : [
          `other (${formatFactValue(data.other.groups)} groups${cite("/result/other/groups")}): ${row("/result/other", data.other)}`,
        ]),
    ...(data.outliers === undefined
      ? []
      : [
          `Outlier baseline: ${formatFactValue(data.outliers.baseline_values)} latency values${cite("/result/outliers/baseline_values")}, minimum ${formatFactValue(data.outliers.minimum_baseline)}${cite("/result/outliers/minimum_baseline")}; ${data.outliers.threshold} threshold ${data.outliers.threshold_ms === null ? "unknown" : `${formatFactValue(data.outliers.threshold_ms)} ms${cite("/result/outliers/threshold_ms")}`}; exceedances ${data.outliers.outlier_events === null ? "unknown" : `${formatFactValue(data.outliers.outlier_events)}${cite("/result/outliers/outlier_events")}`}, rate ${data.outliers.rate === null ? "unknown" : `${formatFactValue(data.outliers.rate)}${cite("/result/outliers/rate")}`}; cases truncated: ${data.outliers.cases_truncated}, requested case found: ${data.outliers.case_found ?? "not requested"}.`,
          ...data.outliers.cases.map(
            (entry, index) =>
              `Case ${formatFactValue(entry.event_id)}${cite(`/result/outliers/cases/${index}/event_id`)}: ${formatFactValue(entry.latency_ms)} ms${cite(`/result/outliers/cases/${index}/latency_ms`)}, request ${JSON.stringify(entry.request_id)}, exceeds threshold: ${entry.exceeds_threshold ?? "unknown"}.`
          ),
        ]),
    ...notes.map((note) => `Note: ${note}`),
  ]
  return lines.join("\n")
}

/** Key value of a group row under its grouping. */
export function groupValue(
  group: LatencyGroupRow,
  by: LatencyGroup
): string | number | null {
  switch (by) {
    case "endpoint":
      return group.endpoint ?? null
    case "method":
      return group.method ?? null
    case "status":
      return group.status ?? null
    case "component":
      return group.component ?? null
    case "hour":
    case "day":
      return group.bucket_start ?? null
  }
}

/** Display rounding for the text block only; facts keep the exact value. */
function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
