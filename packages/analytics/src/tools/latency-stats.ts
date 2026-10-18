import {
  invalidInput,
  limitExceeded,
  type InputIssue,
  type ToolError,
} from "@workspace/domain/errors"
import { formatFactValue } from "@workspace/domain/facts"
import { validateFilter, type Filter } from "@workspace/domain/filters"
import type { Scope } from "@workspace/domain/receipt"
import {
  bucketCount,
  bucketGrid,
  effectiveRange,
  fillBuckets,
  instantSchema,
  parseInstant,
  type BucketSlot,
  type DataSpan,
  type TimeRange,
} from "@workspace/domain/time"
import {
  defineTool,
  READ_ONLY_ANNOTATIONS,
  renderDescription,
  type ToolContext,
} from "@workspace/domain/tool"
import {
  isTimeGroup,
  LATENCY_DEFAULT_TOP_N,
  LATENCY_FILTER,
  LATENCY_MAX_BUCKETS,
  LATENCY_MAX_TOP_N,
  LATENCY_PERCENTILES,
  latencyStatsFactSpecs,
  latencyStatsInputSchema,
  latencyStatsOutputSchema,
  summarizeLatencyStats,
  type LatencyGroup,
  type LatencyGroupRow,
  type LatencyStatsInput,
  type LatencyStatsOutput,
  type LatencyStatsRow,
} from "@workspace/domain/tools/latency-stats"
import { z } from "zod"

import { corpusNotLoaded, getDataSpan, spanEnd } from "../corpus.ts"
import { apiAccessCondition, compileFilter } from "../filters.ts"
import { describeFilters, scopeFilters } from "../scope.ts"
import { exactCount, isoTime, SqlParams } from "../sql.ts"
import { latencyOutliers } from "../latency-outliers.ts"

/**
 * latency_stats (A-12): latency percentiles and 4xx/5xx rates of OpenStack
 * API accesses (R-01: lines with an HTTP status, with or without request
 * ID), overall or by one grouping.
 *
 * Every call reads the OpenStack data span, then – for hour or day, if the
 * window overlaps the span – the buckets in which OpenStack has any event
 * (capture coverage), then one statement over the filtered accesses: the
 * total row (slot 0) and the groups. For endpoint, method, status and
 * component the groups are ranked by accesses, then key (unique, because
 * the key is the group), and every access of a group beyond top_n falls
 * into one `other` slot, so other's percentiles and distinct requests are
 * computed over its accesses, never averaged. Percentiles come from one
 * `quantile_cont(latency_ms, [0.5, 0.9, 0.95, 0.99])` per row (gate G5),
 * rates as `count(*) FILTER (…)::DOUBLE / NULLIF(count(*), 0)`, all in
 * SereneDB. TypeScript only completes the bucket grid with empty rows.
 */

const PERCENTILES = LATENCY_PERCENTILES.join(", ")

const UNIT_NOTE =
  "Rates are per API access event (OpenStack lines with an HTTP status, with or without request ID); unique requests are counted separately (R-01). rate_5xx = errors_5xx / api_access_events, rate_4xx = errors_4xx / api_access_events."
const STATUS_NOTE =
  "5xx (500–599) are failed API accesses; 4xx (400–499) are client errors, not failed accesses (R-02). Counts are API accesses, not incidents or outages."
const PERCENTILE_NOTE =
  "Percentiles are continuous (quantile_cont: linear interpolation between the two nearest latencies) over the accesses with a latency, in milliseconds as logged (time field of the access line)."

/** SQL expression of the group key, from code only. */
const GROUP_KEY: Record<LatencyGroup, { sql: string; type: string }> = {
  endpoint: { sql: "log_events.endpoint", type: "VARCHAR" },
  method: { sql: "log_events.http_method", type: "VARCHAR" },
  status: { sql: "log_events.http_status", type: "INTEGER" },
  component: { sql: "log_events.component", type: "VARCHAR" },
  hour: { sql: "date_trunc('hour', log_events.ts)", type: "TIMESTAMPTZ" },
  day: { sql: "date_trunc('day', log_events.ts)", type: "TIMESTAMPTZ" },
}

/** Aggregates of one row over `base`. */
const AGGREGATES = [
  "count(*) AS api_access_events",
  "count(*) FILTER (WHERE request_id IS NULL) AS without_request_id",
  "count(DISTINCT request_id) AS unique_requests",
  "count(latency_ms) AS latency_values",
  `quantile_cont(latency_ms, [${PERCENTILES}]) AS q`,
  "max(latency_ms) AS max_ms",
  "count(*) FILTER (WHERE http_status BETWEEN 500 AND 599) AS errors_5xx",
  "count(*) FILTER (WHERE http_status BETWEEN 400 AND 499) AS errors_4xx",
].join(", ")

/** Final columns: percentiles from the list, rates over all accesses of the row. */
function outerColumns(key: string): string {
  return [
    "slot",
    `${key} AS g`,
    "groups",
    "api_access_events",
    "without_request_id",
    "unique_requests",
    "latency_values",
    "q[1] AS p50_ms",
    "q[2] AS p90_ms",
    "q[3] AS p95_ms",
    "q[4] AS p99_ms",
    "max_ms",
    "errors_5xx",
    "errors_5xx::DOUBLE / NULLIF(api_access_events, 0) AS rate_5xx",
    "errors_4xx",
    "errors_4xx::DOUBLE / NULLIF(api_access_events, 0) AS rate_4xx",
  ].join(", ")
}

const latencyValue = z.number().nonnegative().nullable()
const ratioValue = z.number().min(0).max(1).nullable()

const statsRow = z.object({
  slot: exactCount,
  g: z.union([z.string(), z.number()]).nullable(),
  groups: exactCount,
  api_access_events: exactCount,
  without_request_id: exactCount,
  unique_requests: exactCount,
  latency_values: exactCount,
  p50_ms: latencyValue,
  p90_ms: latencyValue,
  p95_ms: latencyValue,
  p99_ms: latencyValue,
  max_ms: latencyValue,
  errors_5xx: exactCount,
  rate_5xx: ratioValue,
  errors_4xx: exactCount,
  rate_4xx: ratioValue,
})

type StatsRow = z.infer<typeof statsRow>

const bucketRow = z.object({ bucket: instantSchema })

/** A row without accesses: counts 0, percentiles and rates undetermined. */
const EMPTY_STATS: LatencyStatsRow = {
  api_access_events: 0,
  without_request_id: 0,
  unique_requests: 0,
  latency_values: 0,
  p50_ms: null,
  p90_ms: null,
  p95_ms: null,
  p99_ms: null,
  max_ms: null,
  errors_5xx: 0,
  rate_5xx: null,
  errors_4xx: 0,
  rate_4xx: null,
}

export const latencyStats = defineTool({
  name: "latency_stats",
  title: "Latency and HTTP error rates",
  version: "1.1.0",
  description: renderDescription({
    purpose:
      "Latency percentiles (p50, p90, p95, p99, max in milliseconds) and HTTP error rates of OpenStack API accesses, overall or grouped by endpoint, method, status, component or UTC hour/day. OpenStack only. Every rate comes with numerator and denominator. Optional outliers {threshold:p95|p99,min_baseline,case_event_id?} returns a SQL threshold, baseline denominator, strict exceedances and bounded real cases from the same filtered window; small baselines leave decisions unknown.",
    useWhen:
      "the question is about OpenStack API latency, slow endpoints, latency over time, the 5xx (failed access) rate or the 4xx (client error) rate, or how many API accesses and unique requests a scope has.",
    doNotUseWhen: [
      {
        situation:
          "the question is about BGL (it has no HTTP access lines; dataset bgl fails with invalid_input)",
        use: "count_events",
      },
      {
        situation:
          "you need how often error events (levels ERROR, CRITICAL) occur in the logs",
        use: "count_events",
      },
      {
        situation: "you need recurring patterns or episodes",
        use: "recurring_patterns",
      },
      { situation: "you need example log lines", use: "search_logs" },
    ],
    inputs: `dataset (optional, only openstack), from/to as ISO-8601 with Z or offset, [from, to), default the whole data span; group_by (optional, one of endpoint, method, status, component, hour, day; without it only the total row); top_n (1–${LATENCY_MAX_TOP_N}, default ${LATENCY_DEFAULT_TOP_N}, only with endpoint, method, status or component). endpoints are exact masked paths as returned (IDs replaced by <ID>, <UUID>, <NUM>); http_status is an inclusive range {min, max} within 100–599 – with it every rate is a share of the filtered accesses.`,
    filters: LATENCY_FILTER.summary,
    outputs: `total (all API accesses in scope) and groups[], each with api_access_events (denominator of the rates), without_request_id, unique_requests (distinct request IDs, a separate counting unit), latency_values, p50_ms, p90_ms, p95_ms, p99_ms, max_ms (continuous percentiles over the accesses with a latency, quantile_cont with linear interpolation; null without values), errors_5xx with rate_5xx (status 500–599 / api_access_events) and errors_4xx with rate_4xx (status 400–499 / api_access_events; client errors, not failures). Rates are fractions 0–1 computed in SereneDB; a rate of 0 is an observed zero with its denominator, null means no accesses. other aggregates the groups beyond top_n over their accesses. With hour or day every UTC bucket of the effective range is listed in time order, with partial and capture_gap flags; buckets outside the data span are never listed. Also data_span, effective_range, group_count, truncated, top_n. Cite every number by its fact ID; do not compute rates or percentiles yourself.`,
    truncation: `endpoint, method, status, component: at most top_n groups by api_access_events, the rest aggregated in other and truncated true; total is exact regardless. hour and day: never truncated, at most ${LATENCY_MAX_BUCKETS} buckets (otherwise limit_exceeded).`,
    countingUnit:
      "OpenStack API accesses (lines with an HTTP status, with or without request ID), not log events and not incidents; unique_requests are requests (R-01).",
  }),
  input: latencyStatsInputSchema,
  output: latencyStatsOutputSchema,
  factSpecs: latencyStatsFactSpecs,
  annotations: READ_ONLY_ANNOTATIONS,
  validate: validateLatency,
  summary: summarizeLatencyStats,
  async run(ctx, input) {
    const span = await getDataSpan(ctx.db, "openstack", ctx.signal)
    if (span === null) return { ok: false, error: corpusNotLoaded }
    const window: TimeRange = {
      from: input.from ?? span.first,
      to: input.to ?? spanEnd(span),
    }
    const effective = effectiveRange(window, span)
    const groupBy = input.group_by ?? null
    const time = isTimeGroup(input.group_by)

    let grid: BucketSlot[] = []
    let captured = new Set<bigint>()
    if (groupBy !== null && time && effective !== null) {
      const unit = groupBy === "hour" ? "hour" : "day"
      const needed = bucketCount(effective, unit)
      if (needed > LATENCY_MAX_BUCKETS)
        return {
          ok: false,
          error: {
            ...limitExceeded(
              `Buckets for [${effective.from}, ${effective.to}) by ${unit}`,
              LATENCY_MAX_BUCKETS,
              needed
            ),
            hint: `Use group_by "day" or narrow from/to to at most ${LATENCY_MAX_BUCKETS} ${unit}s.`,
          },
        }
      grid = bucketGrid(effective, unit)
      captured = await capturedBuckets(ctx, unit, effective)
    }

    const params = new SqlParams()
    const compiled = compileFilter(
      { ...filterOf(input), from: window.from, to: window.to },
      { accepted: LATENCY_FILTER.fields, params }
    )
    if (!compiled.ok) return compiled
    const where = [
      ...(compiled.filter.where === "TRUE" ? [] : [compiled.filter.where]),
      apiAccessCondition("log_events"),
    ].join(" AND ")
    const topN =
      time || groupBy === null ? null : (input.top_n ?? LATENCY_DEFAULT_TOP_N)

    const { rows } = await ctx.db.query(
      statement(
        groupBy,
        where,
        // Typed: SereneDB 26.10.1 cannot describe a result whose type depends
        // on an untyped parameter (`$n + 1`) and sends no usable columns (gate G1).
        topN === null ? null : `${params.add(topN)}::BIGINT`
      ),
      params.values,
      ctx.signal
    )
    const parsed = rows.map((row) => statsRow.parse(row))
    const [totalRow, ...groupRows] = parsed
    if (totalRow?.slot !== 0) throw new Error("latency_stats without total row")

    let groups: LatencyGroupRow[] = []
    let other: LatencyStatsOutput["other"] = null
    let groupCount = 0
    if (groupBy !== null && time) {
      groups = fillGrid(groupRows, grid, captured)
      groupCount = groups.length
    } else if (groupBy !== null && topN !== null) {
      groupCount = totalRow.groups
      for (const row of groupRows) {
        if (row.slot > topN) other = { groups: row.groups, ...statsOf(row) }
        else groups.push(keyed(groupBy, row.g, statsOf(row)))
      }
    }

    const data: LatencyStatsOutput = {
      ...(input.outliers === undefined
        ? {}
        : { outliers: await latencyOutliers(ctx, input, where, params) }),
      dataset: "openstack",
      unit: "api_accesses",
      group_by: groupBy,
      data_span: span,
      effective_range: effective,
      total: statsOf(totalRow),
      group_count: groupCount,
      groups,
      other,
      truncated: other !== null,
      top_n: topN,
    }
    const scope: Scope = {
      windows: [{ dataset: "openstack", ...window }],
      filters: scopeFilters(input, LATENCY_FILTER.fields),
    }
    return {
      ok: true,
      run: {
        data,
        scope,
        population: {
          count: data.total.api_access_events,
          unit: "api_accesses",
        },
        rows_returned: groups.length,
        truncated: data.truncated || (data.outliers?.cases_truncated ?? false),
        row_limit: topN ?? (time ? LATENCY_MAX_BUCKETS : null),
        notes: [
          ...notesFor(input, data, scope, window, span),
          ...(input.outliers === undefined
            ? []
            : [
                "Outliers are accesses strictly above the selected SQL percentile over latency_values in the identical filtered window. Below min_baseline, threshold and decisions are unknown. A missing case ID is outside the filtered latency population, not a normal case. The case list contains at most 20 slowest accesses (cases_truncated names the cap). A statistical outlier is an observation, not evidence of a cause.",
              ]),
        ],
      },
    }
  },
})

/**
 * The statement: CTE `base` holds the filtered accesses with their group
 * key. Slot 0 is the total; slots 1… are the groups (ranked, or one per
 * bucket); for ranked groups slot top_n + 1 is other.
 */
function statement(
  groupBy: LatencyGroup | null,
  where: string,
  topN: string | null
): string {
  const key = groupBy === null ? null : GROUP_KEY[groupBy]
  const base = `WITH base AS (SELECT ${key === null ? "NULL" : key.sql} AS g, log_events.request_id, log_events.latency_ms, log_events.http_status FROM log_events WHERE ${where})`
  const nullKey = `NULL::${key?.type ?? "VARCHAR"}`
  const outerKey = key?.type === "TIMESTAMPTZ" ? isoTime("g") : "g"

  if (groupBy === null || key === null)
    return `${base}, agg AS (SELECT 0::BIGINT AS slot, ${nullKey} AS g, 0::BIGINT AS groups, ${AGGREGATES} FROM base) SELECT ${outerColumns(outerKey)} FROM agg`

  if (topN === null)
    return `${base}, agg AS (SELECT 0::BIGINT AS slot, ${nullKey} AS g, count(DISTINCT g) AS groups, ${AGGREGATES} FROM base UNION ALL SELECT 1::BIGINT AS slot, g, 1::BIGINT AS groups, ${AGGREGATES} FROM base GROUP BY g) SELECT ${outerColumns(outerKey)} FROM agg ORDER BY slot, agg.g`

  return [
    base,
    `, ranked AS (SELECT g, row_number() OVER (ORDER BY count(*) DESC, g ASC NULLS LAST) AS rank FROM base GROUP BY g)`,
    `, slotted AS (SELECT b.g, b.request_id, b.latency_ms, b.http_status, least(r.rank, ${topN} + 1) AS slot FROM base b JOIN ranked r ON r.g IS NOT DISTINCT FROM b.g)`,
    `, agg AS (SELECT 0::BIGINT AS slot, ${nullKey} AS g, (SELECT count(*) FROM ranked) AS groups, ${AGGREGATES} FROM base`,
    ` UNION ALL SELECT slot, CASE WHEN slot <= ${topN} THEN min(g) END AS g, count(DISTINCT g) AS groups, ${AGGREGATES} FROM slotted GROUP BY slot)`,
    ` SELECT ${outerColumns(outerKey)} FROM agg ORDER BY slot`,
  ].join("")
}

function statsOf(row: StatsRow): LatencyStatsRow {
  return {
    api_access_events: row.api_access_events,
    without_request_id: row.without_request_id,
    unique_requests: row.unique_requests,
    latency_values: row.latency_values,
    p50_ms: row.p50_ms,
    p90_ms: row.p90_ms,
    p95_ms: row.p95_ms,
    p99_ms: row.p99_ms,
    max_ms: row.max_ms,
    errors_5xx: row.errors_5xx,
    rate_5xx: row.rate_5xx,
    errors_4xx: row.errors_4xx,
    rate_4xx: row.rate_4xx,
  }
}

/** A ranked group with its key under the group_by name. */
function keyed(
  groupBy: LatencyGroup,
  value: string | number | null,
  stats: LatencyStatsRow
): LatencyGroupRow {
  switch (groupBy) {
    case "status":
      return { status: z.number().int().parse(value), ...stats }
    case "endpoint":
      return { endpoint: z.string().parse(value), ...stats }
    case "method":
      return { method: z.string().parse(value), ...stats }
    case "component":
      return { component: z.string().parse(value), ...stats }
    case "hour":
    case "day":
      throw new Error("time buckets are not ranked")
  }
}

/**
 * Every bucket of the grid in time order: observed rows, empty rows for
 * buckets without an access, the capture flag from the dataset's events.
 */
function fillGrid(
  rows: readonly StatsRow[],
  grid: readonly BucketSlot[],
  captured: ReadonlySet<bigint>
): LatencyGroupRow[] {
  const observed = rows.map((row) => ({
    bucket: instantSchema.parse(row.g),
    stats: statsOf(row),
  }))
  const filled = fillBuckets(
    observed,
    grid.map((slot) => slot.start),
    (bucket) => ({ bucket, stats: EMPTY_STATS })
  )
  return grid.map((slot, index) => ({
    bucket_start: slot.start,
    bucket_end: slot.end,
    partial: slot.partial,
    capture_gap: !captured.has(instantKey(slot.start)),
    ...(filled[index]?.stats ?? EMPTY_STATS),
  }))
}

/**
 * Buckets in which OpenStack has any log event, regardless of the filters.
 * A bucket without one is a capture gap (concept 5.2): its zero is no
 * observed calm.
 */
async function capturedBuckets(
  ctx: Pick<ToolContext, "db" | "signal">,
  unit: "hour" | "day",
  effective: TimeRange
): Promise<Set<bigint>> {
  const params = new SqlParams()
  const compiled = compileFilter(
    { dataset: "openstack", from: effective.from, to: effective.to },
    { accepted: ["dataset", "from", "to"], params }
  )
  if (!compiled.ok) throw new Error("capture coverage filter rejected")
  const { relation, where } = compiled.filter
  const { rows } = await ctx.db.query(
    `SELECT ${isoTime("c.bucket")} AS bucket FROM (SELECT date_trunc('${unit}', ${relation}.ts) AS bucket FROM ${relation} WHERE ${where} GROUP BY 1) c ORDER BY c.bucket`,
    params.values,
    ctx.signal
  )
  return new Set(rows.map((row) => instantKey(bucketRow.parse(row).bucket)))
}

/** Cross-field rules: the shared filter rules and top_n only for ranked groups. */
function validateLatency(input: LatencyStatsInput): ToolError | null {
  const issues: InputIssue[] = []
  const filterError = validateFilter({ ...input, dataset: "openstack" })
  if (filterError?.code === "invalid_input") issues.push(...filterError.issues)
  else if (filterError !== null) return filterError
  if (
    input.top_n !== undefined &&
    (input.group_by === undefined || isTimeGroup(input.group_by))
  )
    issues.push({
      path: "top_n",
      message:
        input.group_by === undefined
          ? "top_n needs group_by endpoint, method, status or component."
          : `With ${input.group_by} every bucket is listed; remove top_n.`,
    })
  return issues.length === 0 ? null : invalidInput(issues)
}

function filterOf(input: LatencyStatsInput): Partial<Filter> {
  const filter: Partial<Filter> = {}
  for (const field of LATENCY_FILTER.fields) {
    const value = input[field]
    if (value !== undefined) Object.assign(filter, { [field]: value })
  }
  return filter
}

function instantKey(value: string): bigint {
  const micros = parseInstant(value)
  if (micros === null) throw new RangeError(`not an instant: ${value}`)
  return micros
}

function notesFor(
  input: LatencyStatsInput,
  data: LatencyStatsOutput,
  scope: Scope,
  window: TimeRange,
  span: DataSpan
): string[] {
  const notes = [UNIT_NOTE, STATUS_NOTE, PERCENTILE_NOTE]
  const { total } = data
  const filters = describeFilters(scope.filters)
  const where = `[${window.from}, ${window.to})${filters === "" ? "" : ` with ${filters}`}`
  if (total.api_access_events === 0) {
    notes.push(
      `No API access events in scope: openstack ${where}. Counts are 0; percentiles and rates are null because there is no denominator.`
    )
  } else if (total.errors_5xx === 0) {
    notes.push(
      `no 5xx API access events in scope (observed zero, denominator ${formatFactValue(total.api_access_events)})`
    )
  }
  if (data.effective_range === null)
    notes.push(
      `The window lies outside the OpenStack data span (${span.first} to ${span.last}): its count of 0 is not an observed zero (R-03).`
    )
  else if (
    instantKey(data.effective_range.from) !== instantKey(window.from) ||
    instantKey(data.effective_range.to) !== instantKey(window.to)
  )
    notes.push(
      `The window reaches beyond the OpenStack data span (${span.first} to ${span.last}); only the observed part [${data.effective_range.from}, ${data.effective_range.to}) is counted.`
    )
  if (input.http_status !== undefined)
    notes.push(
      `Only API accesses with status ${input.http_status.min}–${input.http_status.max} are in scope, so every rate is a share of these filtered accesses, not of all accesses.`
    )
  if (total.latency_values < total.api_access_events)
    notes.push(
      `${formatFactValue(total.api_access_events - total.latency_values)} API accesses have no latency; they are counted but not in the percentiles.`
    )
  if (data.truncated && data.other !== null)
    notes.push(
      `Truncated: ${data.groups.length} of ${formatFactValue(data.group_count)} groups listed; the other ${formatFactValue(data.other.groups)} are aggregated in other. Raise top_n (max ${LATENCY_MAX_TOP_N}) or narrow the filters to list them.`
    )
  const gaps = data.groups.filter((group) => group.capture_gap === true).length
  if (gaps > 0)
    notes.push(
      `${gaps} bucket(s) marked capture_gap contain no OpenStack event at all: the logs captured nothing there, so their zero is no observed calm.`
    )
  const partial = data.groups.filter((group) => group.partial === true).length
  if (partial > 0)
    notes.push(
      `${partial} bucket(s) marked partial cover less than a full ${input.group_by ?? "bucket"} because the effective range starts or ends inside them.`
    )
  return notes
}
