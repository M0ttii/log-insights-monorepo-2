import { toSafeInteger } from "@workspace/domain/bigint"
import {
  invalidInput,
  type InputIssue,
  type ToolError,
} from "@workspace/domain/errors"
import {
  datasetsWithColumn,
  SPECIFIC_DIMENSION_COLUMNS,
  type SpecificDimension,
} from "@workspace/domain/datasets"
import {
  datasetSchema,
  filterDatasets,
  presentSpecificFilters,
  validateFilter,
  type Dataset,
  type Dimension,
} from "@workspace/domain/filters"
import type { CountingUnit, Scope } from "@workspace/domain/receipt"
import {
  changeLabelSchema,
  referencePeriod,
  type ComparisonCoverage,
} from "@workspace/domain/rules/compare"
import {
  SIGNIFICANT_INCREASE_FACTOR,
  SIGNIFICANT_INCREASE_MIN_EVENTS,
} from "@workspace/domain/rules/thresholds"
import {
  coverage,
  MAX_FRACTION_DIGITS,
  parseInstant,
  type DataSpan,
  type TimeRange,
} from "@workspace/domain/time"
import {
  defineTool,
  READ_ONLY_ANNOTATIONS,
  renderDescription,
} from "@workspace/domain/tool"
import {
  API_ACCESS_DIMENSIONS,
  COMPARE_MAX_TOP_N,
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

import { comparisonCoverageSql } from "../comparison.ts"
import { requireDataSpan } from "../corpus.ts"
import {
  apiAccessCondition,
  compileFilter,
  dimensionExpression,
} from "../filters.ts"
import {
  LOADED,
  describeFilters,
  describeWindows,
  resolveWindows,
  scopeFilters,
  unknownErrorsNote,
  type ResolvedWindow,
} from "../scope.ts"
import { SqlParams } from "../sql.ts"

/**
 * count_events (A-07, A-09): counts over the stated scope, grouped by one or
 * two dimensions, optionally compared with a reference period.
 *
 * Every call reads the data span of each dataset in scope (windows and
 * their coverage), then runs one aggregation: the groups of the filtered
 * scope, ranked uniquely (the dimension values are the group key, NULL
 * last), and a summary row (rank 0) with the total, the number of groups
 * and the `other` sums beyond `top_n`, so total, shares and other cannot
 * disagree. Shares, differences and percentages are computed in SereneDB.
 *
 * Counting unit (R-01, LOG-23): grouping by `http_status` or `endpoint`
 * counts API accesses (the population of the view `api_access`), not log
 * events; BGL-only dimensions, filters or `dataset: bgl` are rejected then.
 *
 * compare (R-06, LOG-24): C = [from, to), B = the previous equally long
 * period or a chosen one of the same length, both with the identical filter
 * in the same statement (`count(*) FILTER (WHERE ts in C | B)`), so a group
 * seen in only one period has 0 in the other. Groups rank by |C − B|, then
 * C, then the value. When a period lies entirely outside the data span the
 * comparison is not determinable: only C is counted, and B, delta, change
 * and classification are null, never 0 (A-09.3, R-03).
 */

const DIMENSION_KEYS = ["g1", "g2"] as const

const LOG_EVENTS_NOTE =
  "Counts are log events (parsed lines), not incidents or outages."
const API_NOTE =
  "Counts are OpenStack API accesses (lines with an HTTP status, with or without request ID), not log events and not requests (R-01)."
const NO_SHARED_AXIS_NOTE =
  "BGL (2005–2006) and OpenStack (2017) share no time axis: numbers across both datasets are totals over each dataset's window, not a comparison over the same time."
const NO_SHARED_AXIS_ALL_NOTE =
  "No two datasets share a time axis (separate systems, even where calendars overlap): numbers across datasets are totals over each dataset's window, not a comparison over the same time."
const TEAM_NOTE =
  "Teams come from a fictional ownership table (Serene Platform); unmapped components are 'unowned'."
const LABEL_NOTE =
  "alert_label is a BGL dataset label, not a finding of this system."
const COMPARE_HINT = `compare needs one dataset (comparisons run within one dataset; no two datasets share a time axis), from and to, exactly one group_by dimension, top_n ≤ ${COMPARE_MAX_TOP_N}, and either "previous_period" or a reference {from, to} as long as [from, to) that does not overlap it.`
const CHANGE_NOTE = `Classification follows R-06: 'significantly increased' needs B > 0, C ≥ ${SIGNIFICANT_INCREASE_FACTOR} · B and at least ${SIGNIFICANT_INCREASE_MIN_EVENTS} more; a change is an observation, not a cause.`

/** BIGINT columns arrive as exact strings and become numbers only after a range check. */
const exactInteger = z
  .union([z.string(), z.number()])
  .transform((value) => toSafeInteger(value))
const exactCount = exactInteger.pipe(z.number().int().nonnegative())

const summaryRow = z.object({
  rank: exactCount.pipe(z.literal(0)),
  events: exactCount,
  baseline: exactCount.nullable(),
  delta: exactInteger.nullable(),
  pct_change: z.number().nullable(),
  classification: changeLabelSchema,
  group_count: exactCount,
  other_groups: exactCount,
  other_events: exactCount,
  other_share: z.number().nullable(),
  other_baseline: exactCount.nullable(),
  other_delta: exactInteger.nullable(),
  other_pct_change: z.number().nullable(),
})

const groupRow = z.object({
  rank: exactCount,
  events: exactCount,
  share: z.number().nullable(),
  baseline: exactCount.nullable(),
  delta: exactInteger.nullable(),
  pct_change: z.number().nullable(),
  classification: changeLabelSchema,
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
  host: z.string().nullable(),
  client_ip: z.string().nullable(),
  thread: z.string().nullable(),
  block_id: z.string().nullable(),
}

/** The two periods of a comparison and what the data span says about them. */
type Periods = {
  current: TimeRange
  baseline: TimeRange
  coverage: ComparisonCoverage
  span: DataSpan
}

export const countEvents = defineTool({
  name: "count_events",
  title: "Count events",
  version: "1.2.0",
  description: renderDescription({
    purpose:
      "Counts log events (or OpenStack API accesses) over the stated scope, grouped by one or two dimensions, with exact total, share per group and the remaining groups summed in other. Without from/to the whole corpus is counted. With compare it also counts an equally long reference period and reports what changed (R-06).",
    useWhen:
      "the question asks how often something happened or how events are distributed, e.g. errors per team, per component, per level, per node, per HTTP status, across the whole corpus or a window. Group by dataset when both datasets are in scope, so their totals stay apart. Use compare for what changed versus the previous period or a chosen reference, first occurrences and escalation.",
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
    inputs: `group_by (1–${COUNT_MAX_DIMENSIONS} distinct dimensions: dataset, team, component, level, alert_label, rack, node, pattern, http_status, endpoint), top_n (1–${COUNT_MAX_TOP_N}, default ${COUNT_DEFAULT_TOP_N}), from/to as ISO-8601 with Z or offset, [from, to); without them each dataset counts over its full data span. text is a full-text condition on the message (all words must occur, case-insensitive whole tokens). http_status and endpoint count OpenStack API accesses and cannot be combined with node, rack, alert_label, only_alerts or dataset bgl. team uses the fictional ownership table; unmapped components are 'unowned'. compare: "previous_period" (the equally long period right before [from, to)) or {from, to} (a reference of the same length, not overlapping); needs exactly one dataset, from and to, exactly one group_by dimension and top_n ≤ ${COMPARE_MAX_TOP_N}; both periods use the same filters.`,
    filters: COUNT_FILTER.summary,
    outputs:
      "total (exact population in scope; with compare C), group_count, groups[] with the group_by values, events and share (fraction of total, 0–1), other (groups, events, share of the groups beyond top_n, or null), comparison (null without compare), unit, truncated and top_n. With compare every group and other also carry baseline (B), delta (C − B), pct_change (percent, null when B = 0) and classification (R-06); comparison has the same for the totals, the coverage of both periods and determinable (false when a period lies outside the data span: then B and the change are null, not 0). A missing dimension value is its own category null. Cite every number by its fact ID; shares, differences and percentages are computed, do not compute your own.",
    truncation: `at most top_n groups, largest first (with compare by |C − B|); the rest is summed in other and truncated is true. total is exact regardless.`,
    countingUnit:
      "log events (parsed lines), not incidents; with http_status or endpoint, OpenStack API accesses (R-01). BGL and OpenStack share no time axis: numbers over both are totals over each dataset's span, and comparisons run within one dataset.",
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

    let windows: ResolvedWindow[]
    let periods: Periods | null = null
    if (input.compare === undefined) {
      const datasets: readonly Dataset[] | typeof LOADED =
        input.dataset !== undefined
          ? [input.dataset]
          : api
            ? ["openstack"]
            : LOADED
      const resolved = await resolveWindows(ctx.db, datasets, input, ctx.signal)
      if (!resolved.ok) return resolved
      windows = resolved.windows
    } else {
      // validateCount guarantees dataset, from, to and a valid reference.
      const { dataset, from, to } = input
      if (dataset === undefined || from === undefined || to === undefined)
        throw new Error("compare without dataset or window")
      const required = await requireDataSpan(ctx.db, dataset, ctx.signal)
      if (!required.ok) return required
      const { span } = required
      const current = { from, to }
      const reference = referencePeriod(current, input.compare)
      if (!reference.ok) throw new Error(reference.reason)
      periods = {
        current,
        baseline: reference.baseline,
        coverage: await comparisonCoverageSql(
          ctx,
          current,
          reference.baseline,
          span
        ),
        span,
      }
      windows = [
        { window: { dataset, ...current, period: "current" }, span },
        {
          window: { dataset, ...reference.baseline, period: "baseline" },
          span,
        },
      ]
    }

    const params = new SqlParams()
    // With compare the window becomes two period conditions below.
    const filter =
      periods === null ? input : { ...input, from: undefined, to: undefined }
    const compiled = compileFilter(filter, {
      accepted: COUNT_FILTER.fields,
      params,
    })
    if (!compiled.ok) return compiled
    const { relation } = compiled.filter
    const conditions = [
      ...(compiled.filter.where === "TRUE" ? [] : [compiled.filter.where]),
      ...(api ? [apiAccessCondition(relation)] : []),
    ]

    const keys = DIMENSION_KEYS.slice(0, input.group_by.length)
    const values = keys.map((key) => `${key} ASC NULLS LAST`).join(", ")
    const inRange = (range: TimeRange) =>
      `${relation}.ts >= ${params.add(range.from)}::TIMESTAMPTZ AND ${relation}.ts < ${params.add(range.to)}::TIMESTAMPTZ`
    let counts = "count(*) AS events, NULL::BIGINT AS baseline"
    let order = `events DESC, ${values}`
    if (periods !== null) {
      const inCurrent = inRange(periods.current)
      if (periods.coverage.determinable) {
        const inBaseline = inRange(periods.baseline)
        conditions.push(`((${inCurrent}) OR (${inBaseline}))`)
        counts = `count(*) FILTER (WHERE ${inCurrent}) AS events, count(*) FILTER (WHERE ${inBaseline}) AS baseline`
        order = `abs(events - baseline) DESC, events DESC, ${values}`
      } else {
        // B has no observed count; only C is counted, B stays NULL.
        conditions.push(inCurrent)
      }
    }
    const where = conditions.length === 0 ? "TRUE" : conditions.join(" AND ")
    const topN = params.add(input.top_n)
    const selected = input.group_by
      .map(
        (dimension, i) =>
          `${dimensionExpression(dimension, relation)} AS ${keys[i]}`
      )
      .join(", ")
    const nulls = keys.map((key) => `NULL AS ${key}`).join(", ")
    const beyond = `FILTER (WHERE rank > ${topN})`
    // Without a determinable comparison every baseline column is NULL; with
    // one, an empty sum of baselines is an observed 0.
    const compared = periods?.coverage.determinable === true
    const sumOf = (column: string) =>
      compared ? `coalesce(${column}, 0)` : column

    const factor = `${params.add(SIGNIFICANT_INCREASE_FACTOR)}::BIGINT`
    const minimum = `${params.add(SIGNIFICANT_INCREASE_MIN_EVENTS)}::BIGINT`
    const change = (b: string, c: string, prefix = "") =>
      changeSql(b, c, factor, minimum, prefix)

    const counted = await ctx.db.query(
      [
        `WITH grouped AS (SELECT ${selected}, ${counts} FROM ${relation} WHERE ${where} GROUP BY ${keys.map((_, i) => i + 1).join(", ")})`,
        `, ranked AS (SELECT ${keys.join(", ")}, events, baseline, row_number() OVER (ORDER BY ${order}) AS rank, sum(events) OVER () AS total FROM grouped)`,
        `, summary AS (SELECT coalesce(sum(events), 0) AS c, sum(baseline) AS b, count(*) AS n, count(*) ${beyond} AS other_n, coalesce(sum(events) ${beyond}, 0) AS other_c, sum(baseline) ${beyond} AS other_b FROM ranked)`,
        ` SELECT 0::BIGINT AS rank, ${nulls}, c::BIGINT AS events, NULL::DOUBLE AS share, ${change(sumOf("b"), "c")}, n::BIGINT AS group_count, other_n::BIGINT AS other_groups, other_c::BIGINT AS other_events, other_c::DOUBLE / NULLIF(c, 0) AS other_share, ${change(sumOf("other_b"), "other_c", "other_")} FROM summary`,
        ` UNION ALL SELECT rank, ${keys.join(", ")}, events, events::DOUBLE / NULLIF(total, 0), ${change("baseline", "events")}, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM ranked WHERE rank <= ${topN} ORDER BY rank`,
      ].join(""),
      params.values,
      ctx.signal
    )

    const [first, ...rest] = counted.rows
    const summary = summaryRow.parse(first)
    const groups: CountGroup[] = rest.map((row) => {
      const parsed = groupRow.parse(row)
      const group: CountGroup = { events: parsed.events, share: parsed.share }
      input.group_by.forEach((dimension, i) => {
        Object.assign(group, {
          [dimension]: DIMENSION_VALUE[dimension].parse(row[keys[i] ?? ""]),
        })
      })
      return periods === null ? group : { ...group, ...changeOf(parsed) }
    })
    const other =
      summary.other_groups === 0
        ? null
        : {
            groups: summary.other_groups,
            events: summary.other_events,
            share: summary.other_share,
            ...(periods === null
              ? {}
              : changeFields(
                  summary.other_baseline,
                  summary.other_delta,
                  summary.other_pct_change
                )),
          }
    const data: CountEventsOutput = {
      group_by: input.group_by,
      unit,
      total: summary.events,
      group_count: summary.group_count,
      groups,
      other,
      comparison:
        periods === null
          ? null
          : {
              reference:
                input.compare === "previous_period"
                  ? "previous_period"
                  : "custom",
              coverage: {
                current: periods.coverage.current,
                baseline: periods.coverage.baseline,
              },
              determinable: compared,
              ...changeOf({
                baseline: summary.baseline,
                delta: summary.delta,
                pct_change: summary.pct_change,
                classification: summary.classification,
              }),
            },
      truncated: summary.other_groups > 0,
      top_n: input.top_n,
    }
    const scope: Scope = {
      windows: windows.map(({ window }) => window),
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
        notes: notesFor(input, data, scope, windows, periods),
      },
    }
  },
})

/**
 * B, C − B and the change in percent as SQL columns, from a baseline and a
 * current expression. NULL baselines (no determinable comparison) stay NULL
 * through the arithmetic.
 */
function changeSql(
  baseline: string,
  current: string,
  factor: string,
  minimum: string,
  prefix = ""
): string {
  const classification =
    prefix === ""
      ? `, CASE WHEN ${baseline} IS NULL THEN NULL WHEN ${baseline} = 0 AND ${current} > 0 THEN 'first observed in this comparison' WHEN ${baseline} = 0 THEN 'not observed in either period' WHEN ${current} >= ${factor} * ${baseline} AND ${current} - ${baseline} >= ${minimum} THEN 'significantly increased' END AS classification`
      : ""
  return `${baseline}::BIGINT AS ${prefix}baseline, (${current} - ${baseline})::BIGINT AS ${prefix}delta, 100 * (${current} - ${baseline})::DOUBLE / NULLIF(${baseline}, 0) AS ${prefix}pct_change${classification}`
}

/** R-06 fields already computed by SereneDB. */
function changeOf(row: {
  baseline: number | null
  delta: number | null
  pct_change: number | null
  classification: import("@workspace/domain/rules/compare").ChangeLabel
}) {
  return {
    ...changeFields(row.baseline, row.delta, row.pct_change),
    classification: row.classification,
  }
}

function changeFields(
  baseline: number | null,
  delta: number | null,
  pct: number | null
) {
  return {
    baseline,
    delta: baseline === null ? null : delta,
    pct_change: baseline === null ? null : pct,
  }
}

/** Datasets a dataset-specific dimension applies to; null for shared ones. */
function dimensionDatasets(dimension: Dimension): Dataset[] | null {
  return dimension in SPECIFIC_DIMENSION_COLUMNS
    ? datasetsWithColumn(
        SPECIFIC_DIMENSION_COLUMNS[dimension as SpecificDimension]
      )
    : null
}

/**
 * Cross-field rules: distinct dimensions, the API access population, the
 * rules of compare and the shared filter rules.
 */
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
  const specificFilters = presentSpecificFilters(input)
  if (api) {
    const apiDimensions = input.group_by
      .filter((dimension) => API_ACCESS_DIMENSIONS.includes(dimension))
      .join(", ")
    for (const dimension of input.group_by) {
      const datasets = dimensionDatasets(dimension)
      if (datasets !== null && !datasets.includes("openstack"))
        issues.push({
          path: "group_by",
          message: `${dimension} is ${datasets.join(", ")}-only; ${apiDimensions} counts OpenStack API accesses.`,
        })
    }
    if (input.dataset !== undefined && input.dataset !== "openstack")
      issues.push({
        path: "dataset",
        message: `${apiDimensions} counts OpenStack API accesses; use dataset openstack or leave it out.`,
      })
    for (const field of specificFilters) {
      const datasets = filterDatasets(field)
      if (!datasets.includes("openstack"))
        issues.push({
          path: field,
          message: `${datasets.join(", ")}-only; ${apiDimensions} counts OpenStack API accesses.`,
        })
    }
  } else if (input.dataset !== undefined) {
    // A dataset-specific dimension for a dataset without that column would
    // only yield the null category: rejected with a hint instead (U26).
    for (const dimension of input.group_by) {
      const datasets = dimensionDatasets(dimension)
      if (datasets !== null && !datasets.includes(input.dataset))
        issues.push({
          path: "group_by",
          message: `${dimension} has no meaning for dataset ${input.dataset}; only for ${datasets.join(", ")} (describe_corpus lists the dimensions per dataset).`,
        })
    }
  }

  const compareIssues =
    input.compare === undefined ? [] : validateCompare(input)
  issues.push(...compareIssues)

  // With API dimensions the non-OpenStack fields were reported above.
  const filterError = validateFilter(
    api
      ? {
          ...input,
          dataset: "openstack",
          ...Object.fromEntries(
            specificFilters
              .filter((field) => !filterDatasets(field).includes("openstack"))
              .map((field) => [field, undefined])
          ),
        }
      : input
  )
  if (filterError?.code === "invalid_input") issues.push(...filterError.issues)
  else if (filterError !== null) return filterError
  if (issues.length === 0) return null
  if (compareIssues.length > 0) return invalidInput(issues, COMPARE_HINT)
  return invalidInput(
    issues,
    api
      ? "http_status and endpoint count OpenStack API accesses: group or filter by fields of other datasets in a separate call."
      : undefined
  )
}

/** compare (R-06): one dataset, a set window, one dimension, top_n ≤ 25, a comparable reference. */
function validateCompare(input: CountEventsInput): InputIssue[] {
  const issues: InputIssue[] = []
  if (input.dataset === undefined)
    issues.push({
      path: "dataset",
      message:
        "compare needs exactly one dataset: comparisons run within one dataset; no two datasets share a time axis.",
    })
  for (const field of ["from", "to"] as const)
    if (input[field] === undefined)
      issues.push({
        path: field,
        message: `compare needs ${field}: the current period is [from, to).`,
      })
  if (input.group_by.length !== 1)
    issues.push({
      path: "group_by",
      message: `compare groups by exactly one dimension; ${input.group_by.length} given.`,
    })
  if (input.top_n > COMPARE_MAX_TOP_N)
    issues.push({
      path: "top_n",
      message: `With compare top_n is at most ${COMPARE_MAX_TOP_N}.`,
    })

  const { compare, from, to } = input
  if (typeof compare === "object") {
    for (const field of ["from", "to"] as const)
      if (parseInstant(compare[field]) === null)
        issues.push({
          path: `compare.${field}`,
          message: `Use ISO-8601 with Z or ±HH:MM and at most ${MAX_FRACTION_DIGITS} fractional digits.`,
        })
  }
  // The reference is checked against a valid window only; validateFilter
  // reports invalid or reversed bounds, and the loop above invalid references.
  const start = from === undefined ? null : parseInstant(from)
  const end = to === undefined ? null : parseInstant(to)
  const referenceParses = !issues.some((issue) =>
    issue.path.startsWith("compare.")
  )
  if (
    compare !== undefined &&
    from !== undefined &&
    to !== undefined &&
    start !== null &&
    end !== null &&
    start < end &&
    referenceParses
  ) {
    const reference = referencePeriod({ from, to }, compare)
    if (!reference.ok)
      issues.push({ path: "compare", message: reference.reason })
  }
  return issues
}

function notesFor(
  input: CountEventsInput,
  data: CountEventsOutput,
  scope: Scope,
  windows: readonly ResolvedWindow[],
  periods: Periods | null
): string[] {
  const notes = [data.unit === "log_events" ? LOG_EVENTS_NOTE : API_NOTE]
  if (periods === null && scope.windows.length > 1)
    // The base-corpus wording stays for BGL and OpenStack alone (U26).
    notes.push(
      scope.windows.every(({ dataset }) => isBase(dataset))
        ? NO_SHARED_AXIS_NOTE
        : NO_SHARED_AXIS_ALL_NOTE
    )
  if (data.total === 0 && (periods === null || data.group_count === 0)) {
    const filters = describeFilters(scope.filters)
    notes.push(
      `Nothing in scope: 0 ${data.unit.replaceAll("_", " ")} in ${describeWindows(scope.windows)}${filters === "" ? "" : ` with ${filters}`}.`
    )
  }
  if (periods === null) {
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
  } else {
    notes.push(...comparisonNotes(input, periods))
  }
  if (data.truncated && data.other !== null)
    notes.push(
      `Truncated: ${data.groups.length} of ${data.group_count} groups listed; the other ${data.other.groups} are summed in other. Raise top_n (max ${periods === null ? COUNT_MAX_TOP_N : COMPARE_MAX_TOP_N}) or narrow the filters to list them.`
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
  notes.push(...unknownErrorsNote(input, scope.windows))
  return notes
}

function isBase(dataset: Dataset): boolean {
  return dataset === "bgl" || dataset === "openstack"
}

function comparisonNotes(input: CountEventsInput, periods: Periods): string[] {
  const { current, baseline, coverage: covered, span } = periods
  const dataset = input.dataset ?? ""
  const spanText = `${span.first} to ${span.last}`
  const reference =
    input.compare === "previous_period"
      ? "the previous period of the same length"
      : "the chosen reference of the same length"
  const notes = [
    `Comparison within ${dataset}: C = [${current.from}, ${current.to}), B = [${baseline.from}, ${baseline.to}) (${reference}), same filters.`,
  ]
  if (!covered.determinable) {
    const outside = [
      ...(covered.current === "none" ? ["the current period"] : []),
      ...(covered.baseline === "none" ? ["the baseline"] : []),
    ].join(" and ")
    notes.push(
      `The comparison is not determinable: ${outside} lies outside the ${dataset} data span (${spanText}). B, delta, pct_change and classification are null: no data is not an observed zero (R-03).`
    )
    return notes
  }
  if (covered.baseline === "partial")
    notes.push(
      `The baseline is only partly covered by data (${dataset} data span ${spanText}): B counts only the observed part, so the change is limited and may overstate an increase.`
    )
  if (covered.current === "partial")
    notes.push(
      `The current period is only partly covered by data (${dataset} data span ${spanText}): C counts only the observed part.`
    )
  notes.push(CHANGE_NOTE)
  return notes
}

/** Coverage of a resolved window; an empty window (from ≥ to) covers nothing. */
function windowCoverage(
  window: Scope["windows"][number],
  span: DataSpan
): "full" | "partial" | "none" {
  const from = parseInstant(window.from)
  const to = parseInstant(window.to)
  if (from === null || to === null || from >= to) return "none"
  return coverage(window, span)
}
