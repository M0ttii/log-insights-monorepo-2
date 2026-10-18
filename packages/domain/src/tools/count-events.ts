import { z } from "zod"

import { formatFactValue, type Fact, type FactSpec } from "../facts.ts"
import { datasetSchema, dimensionSchema, pickFilter } from "../filters.ts"
import type { Dimension } from "../filters.ts"
import { countingUnitSchema, type CountingUnit } from "../receipt.ts"
import { changeLabelSchema } from "../rules/compare.ts"
import {
  SIGNIFICANT_INCREASE_FACTOR,
  SIGNIFICANT_INCREASE_MIN_EVENTS,
} from "../rules/thresholds.ts"
import { instantSchema } from "../time.ts"
import type { ToolResult } from "../tool.ts"

/**
 * Contract of count_events (technical.md § 8.2, concept A-07, A-09): counts
 * over the stated scope, grouped by one or two dimensions, with shares and
 * an `other` row computed in SereneDB; with `compare`, the same counts for
 * an equally long reference period and the R-06 change. Frequencies come
 * from this tool, never from search hits (S-06).
 */

export const COUNT_MAX_TOP_N = 50
/** With compare (§ 8.2): each group carries four numbers more. */
export const COMPARE_MAX_TOP_N = 25
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
  "block_id",
  "host",
  "process_id",
  "client_ip",
  "thread",
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

export function countsApiAccesses(groupBy: readonly Dimension[]): boolean {
  return groupBy.some((dimension) => API_ACCESS_DIMENSIONS.includes(dimension))
}

export const compareSchema = z
  .union([
    z
      .literal("previous_period")
      .describe(
        "The immediately preceding period of the same length as [from, to)."
      ),
    z
      .strictObject({
        from: instantSchema.describe("Reference start, inclusive."),
        to: instantSchema.describe(
          "Reference end, exclusive; as long as [from, to) and not overlapping it."
        ),
      })
      .describe("A chosen reference period of the same length."),
  ])
  .describe(
    `Period comparison (R-06): counts the same filters in a reference period B and reports C (the window), B, C − B, the change in percent and a classification per group. Needs exactly one dataset, from and to, exactly one group_by dimension and top_n ≤ ${COMPARE_MAX_TOP_N}.`
  )

export type Compare = z.infer<typeof compareSchema>

export const entityQuerySchema = z
  .strictObject({
    type: z.enum(["ip", "path", "request_id", "object_id"]),
    value: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(
        "Exact, case-sensitive original entity value; omit for the full distribution."
      ),
  })
  .describe(
    "Extract original IPv4/IPv6 addresses, absolute paths, req- request IDs or UUID/block/instance object IDs over every matching log event. Repeated mentions in one event count once."
  )

export const countEventsInputSchema = z.strictObject({
  entity: entityQuerySchema.optional(),
  group_by: z
    .array(dimensionSchema)
    .min(1)
    .max(COUNT_MAX_DIMENSIONS)
    .describe(
      `1–${COUNT_MAX_DIMENSIONS} distinct dimensions to group by: dataset, team (fictional ownership, unmapped components are 'unowned'), component, level, alert_label (BGL dataset label), rack, node (BGL), pattern (pattern_id), http_status, endpoint (OpenStack API accesses), host (OpenSSH, Linux), client_ip (OpenSSH, Apache), thread (ZooKeeper), block_id (HDFS); for otel only dataset, team, component (service) and level. Groups are the combinations of their values; a missing value (e.g. node for OpenStack) is its own category null. A dataset-specific dimension with a dataset that lacks it is rejected. With compare exactly one.`
    ),
  ...COUNT_FILTER.shape,
  top_n: z
    .number()
    .int()
    .min(1)
    .max(COUNT_MAX_TOP_N)
    .default(COUNT_DEFAULT_TOP_N)
    .describe(
      `Groups to return (1–${COUNT_MAX_TOP_N}; with compare 1–${COMPARE_MAX_TOP_N}), largest first. Default: ${COUNT_DEFAULT_TOP_N}. The remaining groups are summed in other; total is exact regardless.`
    ),
  compare: compareSchema.optional(),
  contributions: z
    .boolean()
    .optional()
    .describe(
      "Opt in to signed contributions and positive/negative delta reconciliation; requires compare. Omit to preserve the ordinary comparison output."
    ),
})

export type CountEventsInput = z.infer<typeof countEventsInputSchema>

const count = z.number().int().nonnegative()
const ratio = z.number().min(0).max(1)
const dimensionValue = (description: string) =>
  z.string().nullable().optional().describe(description)

/** Fields a group or other carries with compare; absent without it. */
const changeShape = {
  contribution_to_delta: z
    .number()
    .nullable()
    .optional()
    .describe(
      "Only with contributions true: 100 * group delta / total delta, computed in SQL; null when the net delta is zero or unknown. Signed contributions may exceed 100%."
    ),
  baseline: count
    .nullable()
    .optional()
    .describe(
      "Only with compare: count B in the reference period; null when the comparison is not determinable."
    ),
  delta: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Only with compare: C − B; null when not determinable."),
  pct_change: z
    .number()
    .nullable()
    .optional()
    .describe(
      "Only with compare: 100 · (C − B) / B in percent, computed in SereneDB; null when B = 0 or not determinable."
    ),
}

const classificationSchema = changeLabelSchema.describe(
  `Only with compare, R-06: 'first observed in this comparison' (B = 0, C > 0), 'not observed in either period' (C = B = 0), 'significantly increased' (B > 0, C ≥ ${SIGNIFICANT_INCREASE_FACTOR} · B and C − B ≥ ${SIGNIFICANT_INCREASE_MIN_EVENTS}); null when none applies or not determinable.`
)

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
  host: dimensionValue("OpenSSH or Linux syslog host."),
  client_ip: dimensionValue(
    "OpenSSH or Apache remote IPv4 address; null when the line names none."
  ),
  thread: dimensionValue("ZooKeeper thread name."),
  block_id: dimensionValue("HDFS block ID."),
  events: count.describe(
    "Count of the group in the counting unit; with compare the count C in [from, to)."
  ),
  share: ratio
    .nullable()
    .describe(
      "events / total as a fraction (0–1), computed in SereneDB, unrounded; null when total is 0."
    ),
  ...changeShape,
  classification: classificationSchema.optional(),
})

export type CountGroup = z.infer<typeof countGroupSchema>

export const coverageSchema = z
  .enum(["full", "partial", "none"])
  .describe(
    "Share of the period inside the dataset's data span: full, partial (only the observed part is counted) or none (no observed count)."
  )

export const comparisonSchema = z
  .strictObject({
    reference: z
      .enum(["previous_period", "custom"])
      .describe(
        "previous_period or a chosen reference; both windows are in scope.windows with period current and baseline."
      ),
    coverage: z
      .strictObject({ current: coverageSchema, baseline: coverageSchema })
      .describe("Data-span coverage of both periods (R-03)."),
    determinable: z
      .boolean()
      .describe(
        "False when a period lies entirely outside the data span: then B, delta, pct_change and classification are null everywhere, never 0."
      ),
    ...changeShape,
    decomposition: z
      .strictObject({
        positive_delta: count,
        negative_delta: z.number().int().nonpositive(),
        net_delta: z.number().int(),
      })
      .nullable()
      .optional()
      .describe(
        "Only with contributions true: all group deltas; positive plus negative equals net_delta; null when comparison is unknown."
      ),
    classification: classificationSchema,
  })
  .describe(
    "Totals of the comparison: B, C − B, change and R-06 classification of total (= C)."
  )

export const entityDistributionSchema = z
  .strictObject({
    type: entityQuerySchema.shape.type,
    value: z.string().optional(),
    total_events: count,
    matched_events: count.describe(
      "Events with at least one selected entity; distinct events, never mentions."
    ),
    occurrences: count.describe(
      "Distinct event/entity pairs; one event may contribute to several entities."
    ),
    distinct_entities: count,
    groups: z
      .array(
        z.strictObject({
          entity: z.string(),
          events: count,
          share: ratio.nullable(),
        })
      )
      .max(COUNT_MAX_TOP_N),
    other: z
      .strictObject({
        entities: count,
        events: count,
        share: z.number().nonnegative().nullable(),
      })
      .nullable(),
    truncated: z.boolean(),
  })
  .describe(
    "Complete-scope entity distribution, original strings unchanged. shares use total_events; their sum can exceed one because an event may contain several entities. other.events sums event/entity pairs, not unique events."
  )

export const countEventsOutputSchema = z.strictObject({
  entity_distribution: entityDistributionSchema.optional(),
  group_by: z
    .array(dimensionSchema)
    .describe("The grouping dimensions, in this order."),
  unit: countingUnitSchema,
  total: count.describe(
    "Exact population in scope (all groups, including other); with compare C over [from, to)."
  ),
  group_count: count.describe(
    "Number of distinct groups in scope; with compare in either period."
  ),
  groups: z
    .array(countGroupSchema)
    .max(COUNT_MAX_TOP_N)
    .describe(
      "At most top_n groups: events descending, then the dimension values ascending with null last. With a determinable compare: |C − B| descending, then C descending, then the value."
    ),
  other: z
    .strictObject({
      groups: count.describe("Groups summed here."),
      events: count.describe("Their count in the counting unit (C)."),
      share: ratio
        .nullable()
        .describe("events / total as a fraction (0–1); null when total is 0."),
      ...changeShape,
    })
    .nullable()
    .describe("Groups beyond top_n, summed; null when every group is listed."),
  comparison: comparisonSchema
    .nullable()
    .describe("Period comparison; null without compare."),
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
 * dimensions, and the metric of a count names the counting unit. With
 * compare, counts are `<metric>_current` and `<metric>_baseline`, and the
 * windows are told apart by `period`.
 */
export function countEventsFactSpecs(
  input: Pick<
    CountEventsInput,
    "group_by" | "compare" | "entity" | "contributions"
  >
): FactSpec[] {
  const unit: CountingUnit = countsApiAccesses(input.group_by)
    ? "api_accesses"
    : "log_events"
  const base = countMetric(unit)
  const compared = input.compare !== undefined
  const metric = compared ? `${base}_current` : base
  const groupKeys = [...input.group_by]
  const windowKeys = compared ? ["dataset", "period"] : ["dataset"]
  /** B, C − B and the change of one row; `other` facts carry the prefix other_. */
  const changes = (
    path: string,
    keys: string[],
    prefix: "" | "other_"
  ): FactSpec[] =>
    compared
      ? [
          {
            path: `${path}/baseline`,
            metric: `${prefix}${base}_baseline`,
            unit,
            groupKeys: keys,
          },
          {
            path: `${path}/delta`,
            metric: `${prefix}delta`,
            unit,
            groupKeys: keys,
          },
          {
            path: `${path}/pct_change`,
            metric: `${prefix}pct_change`,
            unit: "percent",
            groupKeys: keys,
          },
        ]
      : []
  const entitySummaryKeys = [
    "type",
    ...(input.entity?.value === undefined ? [] : ["value"]),
  ]
  const entitySpecs: FactSpec[] = [
    ...(
      [
        "total_events",
        "matched_events",
        "occurrences",
        "distinct_entities",
      ] as const
    ).map((field) => ({
      path: `/result/entity_distribution/${field}`,
      metric: `entity_${field}`,
      unit:
        field === "distinct_entities"
          ? "entities"
          : field === "occurrences"
            ? "event_entity_pairs"
            : "log_events",
      groupKeys: entitySummaryKeys,
    })),
    {
      path: "/result/entity_distribution/groups/*/events",
      metric: "entity_events",
      unit: "log_events",
      groupKeys: ["type", "entity"],
    },
    {
      path: "/result/entity_distribution/groups/*/share",
      metric: "entity_share",
      unit: "ratio",
      groupKeys: ["type", "entity"],
    },
    {
      path: "/result/entity_distribution/other/entities",
      metric: "other_entities",
      unit: "entities",
      groupKeys: entitySummaryKeys,
    },
    {
      path: "/result/entity_distribution/other/events",
      metric: "other_entity_events",
      unit: "event_entity_pairs",
      groupKeys: entitySummaryKeys,
    },
    {
      path: "/result/entity_distribution/other/share",
      metric: "other_entity_share",
      unit: "ratio",
      groupKeys: entitySummaryKeys,
    },
  ]
  const comparisonSpecs: FactSpec[] = [
    ...["groups/*", "other"].map((part) => ({
      path: `/result/${part}/contribution_to_delta`,
      metric: "contribution_to_delta",
      unit: "percent",
      groupKeys: part === "other" ? [] : groupKeys,
    })),
    ...["positive_delta", "negative_delta", "net_delta"].map((field) => ({
      path: `/result/comparison/decomposition/${field}`,
      metric: field,
      unit,
      groupKeys: [],
    })),
  ]
  return [
    { path: "/result/total", metric, unit, groupKeys: [] },
    {
      path: "/result/group_count",
      metric: "groups",
      unit: "groups",
      groupKeys: [],
    },
    { path: "/result/groups/*/events", metric, unit, groupKeys },
    {
      path: "/result/groups/*/share",
      metric: "share",
      unit: "ratio",
      groupKeys,
    },
    ...changes("/result/groups/*", groupKeys, ""),
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
    ...changes("/result/other", [], "other_"),
    ...changes("/result/comparison", [], ""),
    {
      path: "/scope/windows/*/from",
      metric: "window_start",
      unit: "utc_time",
      groupKeys: windowKeys,
    },
    {
      path: "/scope/windows/*/to",
      metric: "window_end",
      unit: "utc_time",
      groupKeys: windowKeys,
    },
    ...(input.entity === undefined ? [] : entitySpecs),
    ...(compared && input.contributions === true ? comparisonSpecs : []),
  ]
}

/**
 * Short text for clients without structured output (MCP text block, § 9):
 * total, groups and other with their fact IDs, the comparison, the scope
 * and the notes. Dimension values can be log-derived text, so they appear
 * as JSON literals.
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
  const change = (prefix: string, row: ChangeFields): string => {
    if (data.comparison === null) return ""
    if (row.baseline === null || row.baseline === undefined)
      return "; baseline not determinable"
    const pct =
      row.pct_change === null || row.pct_change === undefined
        ? "no relative change (B = 0)"
        : `${signed(round2(row.pct_change))} %${cite(`${prefix}/pct_change`)}`
    const label =
      "classification" in row && typeof row.classification === "string"
        ? `, ${row.classification}`
        : ""
    const contribution =
      row.contribution_to_delta == null
        ? ""
        : `; contribution to net delta ${signed(row.contribution_to_delta)} %${cite(`${prefix}/contribution_to_delta`)}`
    return `; baseline ${formatFactValue(row.baseline)}${cite(`${prefix}/baseline`)}, delta ${signed(row.delta ?? 0)}${cite(`${prefix}/delta`)}, ${pct}${label}${contribution}`
  }
  const unit = data.unit.replaceAll("_", " ")
  const windows = receipt.scope.windows
    .map(
      ({ dataset, from, to, period }) =>
        `${dataset}${period === undefined ? "" : ` ${period}`} [${from}, ${to})`
    )
    .join(", ")
  const comparison = data.comparison
  const lines = [
    `count_events by ${data.group_by.join(", ")}${comparison === null ? "" : ` compared with ${comparison.reference.replaceAll("_", " ")}`} · receipt ${receipt.receipt_id}`,
    `Scope: ${windows}.`,
    `${formatFactValue(data.total)} ${unit} in scope${cite("/result/total")} in ${formatFactValue(data.group_count)} groups${cite("/result/group_count")}; ${data.groups.length} shown, truncated: ${data.truncated}${comparison === null ? "" : change("/result/comparison", comparison)}.`,
    ...(comparison === null
      ? []
      : [
          `Coverage: current ${comparison.coverage.current}, baseline ${comparison.coverage.baseline}; determinable: ${comparison.determinable}.`,
        ]),
    ...data.groups.map((group, index) => {
      const key = data.group_by
        .map(
          (dimension) =>
            `${dimension}=${JSON.stringify(group[dimension] ?? null)}`
        )
        .join(", ")
      const prefix = `/result/groups/${index}`
      return `${index + 1}. ${key}: ${formatFactValue(group.events)}${cite(`${prefix}/events`)} (${percent(group.share)}${cite(`${prefix}/share`)})${change(prefix, group)}`
    }),
    ...(data.other === null
      ? []
      : [
          `other: ${formatFactValue(data.other.groups)} groups${cite("/result/other/groups")}, ${formatFactValue(data.other.events)}${cite("/result/other/events")} (${percent(data.other.share)}${cite("/result/other/share")})${change("/result/other", data.other)}`,
        ]),
    ...(data.comparison?.decomposition == null
      ? []
      : [
          `Delta reconciliation: positive ${formatFactValue(data.comparison.decomposition.positive_delta)}${cite("/result/comparison/decomposition/positive_delta")}, negative ${formatFactValue(data.comparison.decomposition.negative_delta)}${cite("/result/comparison/decomposition/negative_delta")}, net ${formatFactValue(data.comparison.decomposition.net_delta)}${cite("/result/comparison/decomposition/net_delta")}.`,
        ]),
    ...(data.entity_distribution === undefined
      ? []
      : [
          `Entity distribution (${data.entity_distribution.type}, exact selection ${JSON.stringify(data.entity_distribution.value ?? null)}): ${formatFactValue(data.entity_distribution.matched_events)} matching events${cite("/result/entity_distribution/matched_events")} / ${formatFactValue(data.entity_distribution.total_events)} scoped events${cite("/result/entity_distribution/total_events")}; ${formatFactValue(data.entity_distribution.occurrences)} event/entity pairs${cite("/result/entity_distribution/occurrences")}, ${formatFactValue(data.entity_distribution.distinct_entities)} distinct entities${cite("/result/entity_distribution/distinct_entities")}; truncated: ${data.entity_distribution.truncated}.`,
          ...data.entity_distribution.groups.map(
            (group, index) =>
              `${JSON.stringify(group.entity)}: ${formatFactValue(group.events)} events${cite(`/result/entity_distribution/groups/${index}/events`)}, share ${percent(group.share)}${cite(`/result/entity_distribution/groups/${index}/share`)}.`
          ),
          ...(data.entity_distribution.other === null
            ? []
            : [
                `Other entities: ${formatFactValue(data.entity_distribution.other.entities)}${cite("/result/entity_distribution/other/entities")}, ${formatFactValue(data.entity_distribution.other.events)} event/entity pairs${cite("/result/entity_distribution/other/events")}, summed share ${percent(data.entity_distribution.other.share)}${cite("/result/entity_distribution/other/share")}.`,
              ]),
        ]),
    ...notes.map((note) => `Note: ${note}`),
  ]
  return lines.join("\n")
}

type ChangeFields = {
  baseline?: number | null | undefined
  delta?: number | null | undefined
  pct_change?: number | null | undefined
  classification?: string | null | undefined
  contribution_to_delta?: number | null | undefined
}

/** Percent with two decimals for the text block only; facts keep the exact share. */
function percent(share: number | null): string {
  if (share === null) return "share n/a"
  if (share > 0 && share < 0.0001) return "< 0.01 %"
  return `${formatFactValue(round2(share * 100))} %`
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${formatFactValue(value)}`
}
