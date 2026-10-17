import { z } from "zod"

import { formatFactValue, type Fact, type FactSpec } from "../facts.ts"
import { datasetSchema, dimensionSchema, pickFilter } from "../filters.ts"
import type { Dimension } from "../filters.ts"
import { countingUnitSchema, type CountingUnit } from "../receipt.ts"
import type { ToolResult } from "../tool.ts"

/**
 * Contract of count_events (technical.md § 8.2, concept A-07): counts over
 * the stated scope, grouped by one or two dimensions, with shares and an
 * `other` row computed in SereneDB. Frequencies come from this tool, never
 * from search hits (S-06).
 */

export const COUNT_MAX_TOP_N = 50
export const COUNT_DEFAULT_TOP_N = 20
export const COUNT_MAX_DIMENSIONS = 2

export const COUNT_FILTER = pickFilter([
  "dataset",
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
  "request_id",
  "instance_id",
  "pattern_id",
  "text",
])

/**
 * Dimensions of OpenStack API access lines. Grouping by one of them counts
 * API accesses (R-01) over the population of the view `api_access`, never
 * log events, so the two units are not mixed.
 */
export const API_ACCESS_DIMENSIONS: readonly Dimension[] = [
  "http_status",
  "endpoint",
]

/** BGL-only dimensions; they carry no value on API access lines. */
export const BGL_DIMENSIONS: readonly Dimension[] = [
  "node",
  "rack",
  "alert_label",
]

export function countsApiAccesses(groupBy: readonly Dimension[]): boolean {
  return groupBy.some((dimension) => API_ACCESS_DIMENSIONS.includes(dimension))
}

export const countEventsInputSchema = z.strictObject({
  group_by: z
    .array(dimensionSchema)
    .min(1)
    .max(COUNT_MAX_DIMENSIONS)
    .describe(
      `1–${COUNT_MAX_DIMENSIONS} distinct dimensions to group by: dataset, team (fictional ownership, unmapped components are 'unowned'), component, level, alert_label (BGL dataset label), rack, node (BGL), pattern (pattern_id), http_status, endpoint (OpenStack API accesses). Groups are the combinations of their values; a missing value (e.g. node for OpenStack) is its own category null.`
    ),
  ...COUNT_FILTER.shape,
  top_n: z
    .number()
    .int()
    .min(1)
    .max(COUNT_MAX_TOP_N)
    .default(COUNT_DEFAULT_TOP_N)
    .describe(
      `Groups to return (1–${COUNT_MAX_TOP_N}), largest first. Default: ${COUNT_DEFAULT_TOP_N}. The remaining groups are summed in other; total is exact regardless.`
    ),
})

export type CountEventsInput = z.infer<typeof countEventsInputSchema>

const count = z.number().int().nonnegative()
const ratio = z.number().min(0).max(1)
const dimensionValue = (description: string) =>
  z.string().nullable().optional().describe(description)

/**
 * One group. Exactly the `group_by` dimensions are present; `null` is the
 * category of events without a value for that dimension.
 */
export const countGroupSchema = z.strictObject({
  dataset: datasetSchema.optional(),
  team: z
    .string()
    .optional()
    .describe("Fictional owning team, or 'unowned' for unmapped components."),
  component: dimensionValue("Component or OpenStack service."),
  level: dimensionValue("Level as logged."),
  alert_label: dimensionValue(
    "BGL dataset alert label (not our finding); null = no label."
  ),
  rack: dimensionValue("BGL rack; null for events without a node."),
  node: dimensionValue(
    "BGL node; null for events without a node and for OpenStack."
  ),
  pattern: dimensionValue(
    "pattern_id; pass it as pattern_id filter, recurring_patterns shows the pattern text."
  ),
  http_status: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("HTTP status of the API accesses."),
  endpoint: dimensionValue("API path with IDs masked."),
  events: count.describe("Count of the group in the counting unit."),
  share: ratio.describe(
    "events / total as a fraction (0–1), computed in SereneDB, unrounded."
  ),
})

export type CountGroup = z.infer<typeof countGroupSchema>

export const countEventsOutputSchema = z.strictObject({
  group_by: z
    .array(dimensionSchema)
    .describe("The grouping dimensions, in this order."),
  unit: countingUnitSchema,
  total: count.describe(
    "Exact population in scope (all groups, including other)."
  ),
  group_count: count.describe("Number of distinct groups in scope."),
  groups: z
    .array(countGroupSchema)
    .max(COUNT_MAX_TOP_N)
    .describe(
      "At most top_n groups: events descending, then the dimension values ascending with null last."
    ),
  other: z
    .strictObject({
      groups: count.describe("Groups summed here."),
      events: count.describe("Their count in the counting unit."),
      share: ratio.describe("events / total as a fraction (0–1)."),
    })
    .nullable()
    .describe("Groups beyond top_n, summed; null when every group is listed."),
  truncated: z
    .boolean()
    .describe("True when group_count is larger than the listed groups."),
  top_n: z.number().int().positive().describe("The top_n that applied."),
})

export type CountEventsOutput = z.infer<typeof countEventsOutputSchema>

/** Metric of a count in this unit, so `api_accesses` never reads as events. */
export function countMetric(unit: CountingUnit): string {
  return unit === "log_events" ? "events" : unit
}

/**
 * Facts follow the input: the group of each group fact is its `group_by`
 * dimensions, and the metric of a count names the counting unit.
 */
export function countEventsFactSpecs(
  input: Pick<CountEventsInput, "group_by">
): FactSpec[] {
  const unit: CountingUnit = countsApiAccesses(input.group_by)
    ? "api_accesses"
    : "log_events"
  const metric = countMetric(unit)
  return [
    { path: "/result/total", metric, unit, groupKeys: [] },
    {
      path: "/result/group_count",
      metric: "groups",
      unit: "groups",
      groupKeys: [],
    },
    {
      path: "/result/groups/*/events",
      metric,
      unit,
      groupKeys: [...input.group_by],
    },
    {
      path: "/result/groups/*/share",
      metric: "share",
      unit: "ratio",
      groupKeys: [...input.group_by],
    },
    {
      path: "/result/other/groups",
      metric: "other_groups",
      unit: "groups",
      groupKeys: [],
    },
    {
      path: "/result/other/events",
      metric: `other_${metric}`,
      unit,
      groupKeys: [],
    },
    {
      path: "/result/other/share",
      metric: "other_share",
      unit: "ratio",
      groupKeys: [],
    },
    {
      path: "/scope/windows/*/from",
      metric: "window_start",
      unit: "utc_time",
      groupKeys: ["dataset"],
    },
    {
      path: "/scope/windows/*/to",
      metric: "window_end",
      unit: "utc_time",
      groupKeys: ["dataset"],
    },
  ]
}

/**
 * Short text for clients without structured output (MCP text block, § 9):
 * total, groups and other with their fact IDs, the scope and the notes.
 * Dimension values can be log-derived text, so they appear as JSON literals.
 */
export function summarizeCountEvents(
  result: ToolResult<CountEventsOutput>
): string {
  const { data, facts, receipt, notes } = result
  const byPath = new Map<string, Fact>(facts.map((fact) => [fact.path, fact]))
  const cite = (path: string) => {
    const fact = byPath.get(path)
    return fact === undefined ? "" : ` [${fact.id}]`
  }
  const unit = data.unit.replaceAll("_", " ")
  const windows = receipt.scope.windows
    .map(({ dataset, from, to }) => `${dataset} [${from}, ${to})`)
    .join(", ")
  const lines = [
    `count_events by ${data.group_by.join(", ")} · receipt ${receipt.receipt_id}`,
    `Scope: ${windows}.`,
    `${formatFactValue(data.total)} ${unit} in scope${cite("/result/total")} in ${formatFactValue(data.group_count)} groups${cite("/result/group_count")}; ${data.groups.length} shown, truncated: ${data.truncated}.`,
    ...data.groups.map((group, index) => {
      const key = data.group_by
        .map(
          (dimension) =>
            `${dimension}=${JSON.stringify(group[dimension] ?? null)}`
        )
        .join(", ")
      return `${index + 1}. ${key}: ${formatFactValue(group.events)}${cite(`/result/groups/${index}/events`)} (${percent(group.share)}${cite(`/result/groups/${index}/share`)})`
    }),
    ...(data.other === null
      ? []
      : [
          `other: ${formatFactValue(data.other.groups)} groups${cite("/result/other/groups")}, ${formatFactValue(data.other.events)}${cite("/result/other/events")} (${percent(data.other.share)}${cite("/result/other/share")})`,
        ]),
    ...notes.map((note) => `Note: ${note}`),
  ]
  return lines.join("\n")
}

/** Percent with two decimals for the text block only; facts keep the exact share. */
function percent(share: number): string {
  if (share > 0 && share < 0.0001) return "< 0.01 %"
  return `${formatFactValue(Math.round(share * 10_000) / 100)} %`
}
