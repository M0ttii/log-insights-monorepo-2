import { toSafeInteger } from "@workspace/domain/bigint"
import {
  invalidInput,
  type InputIssue,
  type ToolError,
} from "@workspace/domain/errors"
import {
  datasetSchema,
  validateFilter,
  type Dataset,
  type Dimension,
  type FilterField,
} from "@workspace/domain/filters"
import type { CountingUnit, Scope } from "@workspace/domain/receipt"
import { coverage, parseInstant } from "@workspace/domain/time"
import {
  defineTool,
  READ_ONLY_ANNOTATIONS,
  renderDescription,
} from "@workspace/domain/tool"
import {
  API_ACCESS_DIMENSIONS,
  BGL_DIMENSIONS,
  COUNT_DEFAULT_TOP_N,
  COUNT_FILTER,
  COUNT_MAX_DIMENSIONS,
  COUNT_MAX_TOP_N,
  countEventsFactSpecs,
  countEventsInputSchema,
  countEventsOutputSchema,
  countsApiAccesses,
  summarizeCountEvents,
  type CountEventsInput,
  type CountEventsOutput,
  type CountGroup,
} from "@workspace/domain/tools/count-events"
import { z } from "zod"

import {
  apiAccessCondition,
  compileFilter,
  dimensionExpression,
} from "../filters.ts"
import {
  ALL_DATASETS,
  describeFilters,
  describeWindows,
  resolveWindows,
  scopeFilters,
  type ResolvedWindow,
} from "../scope.ts"
import { SqlParams } from "../sql.ts"

/**
 * count_events (A-07): counts over the stated scope, grouped by one or two
 * dimensions.
 *
 * Every call runs the data span of each dataset in scope (for the windows
 * and their coverage), then one aggregation: the groups of the filtered
 * scope, ranked by `events DESC` and the dimension values ascending with
 * NULL last, which is unique because the values are the group key. The same
 * statement returns a summary row (rank 0) with the total, the number of
 * groups and the `other` sums over the groups beyond `top_n`, so total,
 * shares and other cannot disagree. Shares are divided in SereneDB.
 *
 * Counting unit (R-01, LOG-23): grouping by `http_status` or `endpoint`
 * counts API accesses (the population of the view `api_access`), not log
 * events; BGL-only dimensions, filters or `dataset: bgl` are rejected then.
 */

const DIMENSION_KEYS = ["g1", "g2"] as const

/** BGL-only filter fields; API accesses are OpenStack lines. */
const BGL_FILTERS: readonly FilterField[] = [
  "node",
  "rack",
  "alert_label",
  "only_alerts",
]

const LOG_EVENTS_NOTE =
  "Counts are log events (parsed lines), not incidents or outages."
const API_NOTE =
  "Counts are OpenStack API accesses (lines with an HTTP status, with or without request ID), not log events and not requests (R-01)."
const NO_SHARED_AXIS_NOTE =
  "BGL (2005–2006) and OpenStack (2017) share no time axis: numbers across both datasets are totals over each dataset's window, not a comparison over the same time."
const TEAM_NOTE =
  "Teams come from a fictional ownership table (Serene Platform); unmapped components are 'unowned'."
const LABEL_NOTE =
  "alert_label is a BGL dataset label, not a finding of this system."

/** BIGINT columns arrive as exact strings and become numbers only after a range check. */
const exactCount = z
  .union([z.string(), z.number()])
  .transform((value) => toSafeInteger(value))
  .pipe(z.number().int().nonnegative())

const summaryRow = z.object({
  rank: exactCount.pipe(z.literal(0)),
  events: exactCount,
  group_count: exactCount,
  other_groups: exactCount,
  other_events: exactCount,
  other_share: z.number().nullable(),
})

const groupRow = z.object({
  rank: exactCount,
  events: exactCount,
  share: z.number(),
})

/** Parser of a dimension value as SereneDB returns it. */
const DIMENSION_VALUE: Record<Dimension, z.ZodType<string | number | null>> = {
  dataset: datasetSchema,
  team: z.string(),
  component: z.string().nullable(),
  level: z.string().nullable(),
  alert_label: z.string().nullable(),
  rack: z.string().nullable(),
  node: z.string().nullable(),
  pattern: z.string().nullable(),
  http_status: z.number().int().nullable(),
  endpoint: z.string().nullable(),
}

export const countEvents = defineTool({
  name: "count_events",
  title: "Count events",
  version: "1.0.0",
  description: renderDescription({
    purpose:
      "Counts log events (or OpenStack API accesses) over the stated scope, grouped by one or two dimensions, with exact total, share per group and the remaining groups summed in other. Without from/to the whole corpus is counted.",
    useWhen:
      "the question asks how often something happened or how events are distributed, e.g. errors per team, per component, per level, per node, per HTTP status, across the whole corpus or a window. Group by dataset when both datasets are in scope, so their totals stay apart.",
    doNotUseWhen: [
      {
        situation: "you need a development over time or buckets",
        use: "event_trend",
      },
      {
        situation:
          "you need recurring patterns, episodes or a ranking of what to investigate",
        use: "recurring_patterns",
      },
      {
        situation: "you need latency percentiles or 4xx/5xx rates",
        use: "latency_stats",
      },
      { situation: "you need example log lines", use: "search_logs" },
    ],
    inputs: `group_by (1–${COUNT_MAX_DIMENSIONS} distinct dimensions: dataset, team, component, level, alert_label, rack, node, pattern, http_status, endpoint), top_n (1–${COUNT_MAX_TOP_N}, default ${COUNT_DEFAULT_TOP_N}), from/to as ISO-8601 with Z or offset, [from, to); without them each dataset counts over its full data span. text is a full-text condition on the message (all words must occur, case-insensitive whole tokens). http_status and endpoint count OpenStack API accesses and cannot be combined with node, rack, alert_label, only_alerts or dataset bgl. team uses the fictional ownership table; unmapped components are 'unowned'.`,
    filters: COUNT_FILTER.summary,
    outputs:
      "total (exact population in scope), group_count, groups[] with the group_by values, events and share (fraction of total, 0–1), other (groups, events, share of the groups beyond top_n, or null), unit, truncated and top_n. A missing dimension value is its own category null. Cite every number by its fact ID; shares and totals are computed, do not compute your own.",
    truncation: `at most top_n groups, largest first; the rest is summed in other and truncated is true. total is exact regardless.`,
    countingUnit:
      "log events (parsed lines), not incidents; with http_status or endpoint, OpenStack API accesses (R-01). BGL and OpenStack share no time axis: numbers over both are totals over each dataset's span.",
  }),
  input: countEventsInputSchema,
  output: countEventsOutputSchema,
  factSpecs: countEventsFactSpecs,
  annotations: READ_ONLY_ANNOTATIONS,
  validate: validateCount,
  summary: summarizeCountEvents,
  async run(ctx, input) {
    const api = countsApiAccesses(input.group_by)
    const unit: CountingUnit = api ? "api_accesses" : "log_events"
    const datasets: readonly Dataset[] =
      input.dataset !== undefined
        ? [input.dataset]
        : api
          ? ["openstack"]
          : ALL_DATASETS
    const resolved = await resolveWindows(ctx.db, datasets, input, ctx.signal)
    if (!resolved.ok) return resolved

    const params = new SqlParams()
    const compiled = compileFilter(input, {
      accepted: COUNT_FILTER.fields,
      params,
    })
    if (!compiled.ok) return compiled
    const { relation } = compiled.filter
    const conditions = [
      ...(compiled.filter.where === "TRUE" ? [] : [compiled.filter.where]),
      ...(api ? [apiAccessCondition(relation)] : []),
    ]
    const where = conditions.length === 0 ? "TRUE" : conditions.join(" AND ")
    const topN = params.add(input.top_n)
    const keys = DIMENSION_KEYS.slice(0, input.group_by.length)
    const selected = input.group_by
      .map(
        (dimension, i) =>
          `${dimensionExpression(dimension, relation)} AS ${keys[i]}`
      )
      .join(", ")
    const order = keys.map((key) => `${key} ASC NULLS LAST`).join(", ")
    const other = `sum(events) FILTER (WHERE rank > ${topN})`

    const counted = await ctx.db.query(
      `WITH grouped AS (SELECT ${selected}, count(*) AS events FROM ${relation} WHERE ${where} GROUP BY ${keys.map((_, i) => i + 1).join(", ")}), ranked AS (SELECT ${keys.join(", ")}, events, row_number() OVER (ORDER BY events DESC, ${order}) AS rank, sum(events) OVER () AS total FROM grouped) SELECT 0::BIGINT AS rank, ${keys.map((key) => `NULL AS ${key}`).join(", ")}, coalesce(sum(events), 0)::BIGINT AS events, NULL::DOUBLE AS share, count(*)::BIGINT AS group_count, (count(*) FILTER (WHERE rank > ${topN}))::BIGINT AS other_groups, coalesce(${other}, 0)::BIGINT AS other_events, coalesce(${other}, 0)::DOUBLE / NULLIF(sum(events), 0) AS other_share FROM ranked UNION ALL SELECT rank, ${keys.join(", ")}, events, events::DOUBLE / total, NULL, NULL, NULL, NULL FROM ranked WHERE rank <= ${topN} ORDER BY rank`,
      params.values,
      ctx.signal
    )

    const [first, ...rest] = counted.rows
    const summary = summaryRow.parse(first)
    const groups: CountGroup[] = rest.map((row) => {
      const parsed = groupRow.parse(row)
      const group: CountGroup = { events: parsed.events, share: parsed.share }
      input.group_by.forEach((dimension, i) => {
        const raw = row[keys[i] ?? ""]
        Object.assign(group, {
          [dimension]: DIMENSION_VALUE[dimension].parse(raw),
        })
      })
      return group
    })
    const data: CountEventsOutput = {
      group_by: input.group_by,
      unit,
      total: summary.events,
      group_count: summary.group_count,
      groups,
      other:
        summary.other_groups === 0 || summary.other_share === null
          ? null
          : {
              groups: summary.other_groups,
              events: summary.other_events,
              share: summary.other_share,
            },
      truncated: summary.other_groups > 0,
      top_n: input.top_n,
    }
    const scope: Scope = {
      windows: resolved.windows.map(({ window }) => window),
      filters: scopeFilters(input, COUNT_FILTER.fields),
    }

    return {
      ok: true,
      run: {
        data,
        scope,
        population: { count: data.total, unit },
        rows_returned: groups.length,
        truncated: data.truncated,
        row_limit: input.top_n,
        notes: notesFor(input, data, scope, resolved.windows),
      },
    }
  },
})

/** Clears the BGL-only filters, which validateCount reports itself for API accesses. */
const withoutBglFilters = {
  node: undefined,
  rack: undefined,
  alert_label: undefined,
  only_alerts: undefined,
}

/** Cross-field rules: distinct dimensions, the API access population, and the shared filter rules. */
function validateCount(input: CountEventsInput): ToolError | null {
  const issues: InputIssue[] = []
  const seen = new Set<Dimension>()
  for (const dimension of input.group_by) {
    if (seen.has(dimension))
      issues.push({
        path: "group_by",
        message: `${dimension} is listed twice; dimensions must be distinct.`,
      })
    seen.add(dimension)
  }

  const api = countsApiAccesses(input.group_by)
  if (api) {
    const apiDimensions = input.group_by
      .filter((dimension) => API_ACCESS_DIMENSIONS.includes(dimension))
      .join(", ")
    for (const dimension of input.group_by.filter((d) =>
      BGL_DIMENSIONS.includes(d)
    ))
      issues.push({
        path: "group_by",
        message: `${dimension} is BGL-only; ${apiDimensions} counts OpenStack API accesses.`,
      })
    if (input.dataset === "bgl")
      issues.push({
        path: "dataset",
        message: `${apiDimensions} counts OpenStack API accesses; use dataset openstack or leave it out.`,
      })
    for (const field of BGL_FILTERS.filter((f) => input[f] !== undefined))
      issues.push({
        path: field,
        message: `BGL-only; ${apiDimensions} counts OpenStack API accesses.`,
      })
  }

  // With API dimensions the BGL-only fields were reported above.
  const filterError = validateFilter(
    api ? { ...input, dataset: "openstack", ...withoutBglFilters } : input
  )
  if (filterError?.code === "invalid_input") issues.push(...filterError.issues)
  else if (filterError !== null) return filterError
  if (issues.length === 0) return null
  return invalidInput(
    issues,
    api
      ? "http_status and endpoint count OpenStack API accesses: group or filter by BGL fields in a separate call."
      : undefined
  )
}

function notesFor(
  input: CountEventsInput,
  data: CountEventsOutput,
  scope: Scope,
  windows: readonly ResolvedWindow[]
): string[] {
  const notes = [data.unit === "log_events" ? LOG_EVENTS_NOTE : API_NOTE]
  if (scope.windows.length > 1) notes.push(NO_SHARED_AXIS_NOTE)
  if (data.total === 0) {
    const filters = describeFilters(scope.filters)
    notes.push(
      `Nothing in scope: 0 ${data.unit.replaceAll("_", " ")} in ${describeWindows(scope.windows)}${filters === "" ? "" : ` with ${filters}`}.`
    )
  }
  for (const { window, span } of windows) {
    const covered = windowCoverage(window, span)
    if (covered === "none")
      notes.push(
        `The ${window.dataset} window lies outside its data span (${span.first} to ${span.last}): its count of 0 is not an observed zero (R-03).`
      )
    else if (covered === "partial")
      notes.push(
        `The ${window.dataset} window reaches beyond its data span (${span.first} to ${span.last}); only the observed part is counted.`
      )
  }
  if (data.truncated && data.other !== null)
    notes.push(
      `Truncated: ${data.groups.length} of ${data.group_count} groups listed; the other ${data.other.groups} are summed in other. Raise top_n (max ${COUNT_MAX_TOP_N}) or narrow the filters to list them.`
    )
  if (
    data.groups.some((group) => input.group_by.some((d) => group[d] === null))
  )
    notes.push(
      "null is its own category: these events have no value for that dimension (e.g. node for OpenStack or BGL service-node lines)."
    )
  if (input.group_by.includes("team") || input.teams !== undefined)
    notes.push(TEAM_NOTE)
  if (input.group_by.includes("alert_label") || input.alert_label !== undefined)
    notes.push(LABEL_NOTE)
  return notes
}

/** Coverage of a resolved window; an empty window (from ≥ to) covers nothing. */
function windowCoverage(
  window: Scope["windows"][number],
  span: ResolvedWindow["span"]
): "full" | "partial" | "none" {
  const from = parseInstant(window.from)
  const to = parseInstant(window.to)
  if (from === null || to === null || from >= to) return "none"
  return coverage(window, span)
}
