import { toSafeInteger } from "@workspace/domain/bigint"
import {
  invalidInput,
  limitExceeded,
  type InputIssue,
  type ToolError,
} from "@workspace/domain/errors"
import type { FactSpec } from "@workspace/domain/facts"
import { validateFilter, type Filter } from "@workspace/domain/filters"
import {
  bucketCount,
  bucketGrid,
  bucketUnitSchema,
  effectiveRange,
  fillBuckets,
  instantSchema,
  parseInstant,
  type BucketSlot,
  type BucketUnit,
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
  BGL_ONLY_DIMENSIONS,
  eventTrendInputSchema,
  eventTrendOutputSchema,
  summarizeEventTrend,
  TREND_DIMENSIONS,
  TREND_FILTER,
  TREND_MAX_BUCKETS,
  TREND_MAX_SERIES,
  type EventTrendInput,
  type EventTrendOutput,
  type TrendBucket,
  type TrendDimension,
  type TrendSeries,
} from "@workspace/domain/tools/event-trend"
import { z } from "zod"

import { compileFilter, dimensionExpression } from "../filters.ts"
import { resolveWindows, scopeFilters } from "../scope.ts"
import { isoTime, SqlParams } from "../sql.ts"

/**
 * event_trend (A-08): log events per UTC bucket for one dataset.
 *
 * Every call runs, in this order: the data span of the dataset, then – if
 * the window overlaps it and the grid stays within the bucket limit – the
 * buckets in which the dataset has any event at all (capture coverage),
 * and the counts in scope: one query without split_by, two with it (the
 * series ranking over the whole scope, then the cells per bucket and
 * series, both from the same CTE). SereneDB truncates with `date_trunc` in
 * the session time zone, which the pool fixes to UTC (gate G5); weeks start
 * on Monday. Totals, series ranks and `other` come from SereneDB; the
 * TypeScript side only completes the grid with zeros for buckets inside the
 * span without a row (`fillBuckets`).
 */

/** Slot of `other` in the series query: one past the last named series. */
const OTHER_SLOT = TREND_MAX_SERIES + 1

const COARSER: Record<BucketUnit, BucketUnit | null> = {
  hour: "day",
  day: "week",
  week: null,
}

const BASE_NOTE =
  "Counts are log events (parsed lines), not incidents. Buckets are UTC, [start, end); weeks start on Monday."

/** BIGINT columns arrive as exact strings and become numbers only after a range check. */
const exactCount = z
  .union([z.string(), z.number()])
  .transform((value) => toSafeInteger(value))
  .pipe(z.number().int().nonnegative())

const spanRowTimes = z.object({ bucket: instantSchema })
const bucketRow = z.object({
  bucket: instantSchema,
  events: exactCount,
  total: exactCount,
})
const seriesRow = z.object({
  slot: exactCount,
  value: z.string().nullable(),
  events: exactCount,
  merged_values: exactCount,
  total: exactCount,
})
const cellRow = z.object({
  bucket: instantSchema,
  slot: exactCount,
  events: exactCount,
  bucket_events: exactCount,
})

export const eventTrend = defineTool({
  name: "event_trend",
  title: "Event trend",
  version: "1.0.0",
  description: renderDescription({
    purpose: `Time series of log events for one dataset in hour, day or week buckets (UTC), optionally split by one dimension into at most ${TREND_MAX_SERIES} series plus other. Shows how a pattern, component, team or error class develops over time.`,
    useWhen:
      "the question is about a development over time: when something started, whether it recurs periodically or happened once, whether it escalates or fades, or for a timeline of a pattern (pattern_id) or a team.",
    doNotUseWhen: [
      {
        situation:
          "you need a total, a share or a distribution by group without time",
        use: "count_events",
      },
      {
        situation: "you compare two periods",
        use: "count_events with compare",
      },
      {
        situation: "you need recurring patterns, episodes or a ranking",
        use: "recurring_patterns",
      },
      { situation: "you need example log lines", use: "search_logs" },
    ],
    inputs: `dataset (required, exactly one: bgl or openstack; they share no time axis, so call once per dataset), bucket (hour | day | week; weeks start on Monday 00:00 UTC), from/to as ISO-8601 with Z or offset, [from, to), default the whole data span, split_by (optional, one of ${TREND_DIMENSIONS.join(", ")}; alert_label, rack and node only for bgl). At most ${TREND_MAX_BUCKETS} buckets per call: a longer range fails with limit_exceeded, whose hint names the next coarser bucket or a shorter window.`,
    filters: TREND_FILTER.summary,
    outputs: `data_span (first and last event of the dataset), effective_range (window ∩ data span, the time the buckets cover; null if the window lies outside the data span – then no buckets are returned), bucket_count, total, series[] (top ${TREND_MAX_SERIES} values by events in scope, then value) with events, other (events and merged_values beyond the top ${TREND_MAX_SERIES}), buckets[] by bucket_start with bucket_end, events, series[] in the same order, other_events, partial (window or data span starts or ends inside the bucket, so less time is covered – a lower count is no drop) and capture_gap (the dataset has no event at all in the bucket, so its zero is not observed calm). Buckets inside the effective range without events are observed zeros; buckets outside the data span are never listed. Cite counts by their fact IDs (group dataset, bucket_start and the split dimension).`,
    truncation: `never truncated: more than ${TREND_MAX_BUCKETS} buckets is an error (limit_exceeded); values beyond the top ${TREND_MAX_SERIES} series are summed in other, so every bucket's series plus other_events equal its events.`,
    countingUnit:
      "log events (parsed lines), not incidents; an empty bucket is no outage and a busy bucket no incident.",
  }),
  input: eventTrendInputSchema,
  output: eventTrendOutputSchema,
  factSpecs: factSpecsFor,
  annotations: READ_ONLY_ANNOTATIONS,
  validate: validateTrend,
  summary: summarizeEventTrend,
  async run(ctx, input) {
    const resolved = await resolveWindows(
      ctx.db,
      [input.dataset],
      input,
      ctx.signal
    )
    if (!resolved.ok) return resolved
    const [first] = resolved.windows
    if (first === undefined) throw new Error("no window for the dataset")
    const { span } = first
    const requested: TimeRange = {
      from: first.window.from,
      to: first.window.to,
    }
    const effective = effectiveRange(requested, span)
    const filters = scopeFilters(input, TREND_FILTER.fields)
    const splitBy = input.split_by ?? null

    if (effective === null) {
      return {
        ok: true,
        run: {
          data: {
            dataset: input.dataset,
            bucket: input.bucket,
            split_by: splitBy,
            data_span: span,
            effective_range: null,
            bucket_count: 0,
            total: null,
            series: [],
            other: null,
            buckets: [],
          },
          scope: {
            windows: [{ dataset: input.dataset, ...requested }],
            filters,
          },
          population: null,
          rows_returned: 0,
          truncated: false,
          row_limit: TREND_MAX_BUCKETS,
          notes: [
            BASE_NOTE,
            `The requested range lies outside the data span: ${input.dataset} has events from ${span.first} to ${span.last} only, so [${requested.from}, ${requested.to}) has no buckets; missing data is not zero (R-03).`,
          ],
        },
      }
    }

    const needed = bucketCount(effective, input.bucket)
    if (needed > TREND_MAX_BUCKETS)
      return {
        ok: false,
        error: tooManyBuckets(effective, input.bucket, needed),
      }
    const grid = bucketGrid(effective, input.bucket)

    const covered = await capturedBuckets(ctx, input, effective)
    const params = new SqlParams()
    const compiled = compileFilter(
      { ...filterOf(input), from: effective.from, to: effective.to },
      { accepted: ["dataset", ...TREND_FILTER.fields], params }
    )
    if (!compiled.ok) return compiled
    const { relation, where } = compiled.filter
    const truncate = `date_trunc('${bucketUnitSchema.parse(input.bucket)}', ${relation}.ts)`

    const counted =
      splitBy === null
        ? await countBuckets(ctx, truncate, relation, where, params, grid)
        : await countSeries(
            ctx,
            splitBy,
            truncate,
            relation,
            where,
            params,
            grid
          )

    const buckets = counted.buckets.map((bucket) => ({
      ...bucket,
      capture_gap: !covered.has(instantKey(bucket.bucket_start)),
    }))
    const data: EventTrendOutput = {
      dataset: input.dataset,
      bucket: input.bucket,
      split_by: splitBy,
      data_span: span,
      effective_range: effective,
      bucket_count: buckets.length,
      total: counted.total,
      series: counted.series,
      other: counted.other,
      buckets,
    }

    return {
      ok: true,
      run: {
        data,
        scope: { windows: [{ dataset: input.dataset, ...effective }], filters },
        population: { count: counted.total, unit: "log_events" },
        rows_returned: buckets.length,
        truncated: false,
        row_limit: TREND_MAX_BUCKETS,
        notes: notesFor(input, span, requested, effective, data),
      },
    }
  },
})

type Counted = {
  total: number
  series: TrendSeries[]
  other: EventTrendOutput["other"]
  buckets: Omit<TrendBucket, "capture_gap">[]
}

type Ctx = Pick<ToolContext, "db" | "signal">

/** Bucket totals without split_by: one row per bucket with events, plus the total over all rows. */
async function countBuckets(
  ctx: Ctx,
  truncate: string,
  relation: string,
  where: string,
  params: SqlParams,
  grid: readonly BucketSlot[]
): Promise<Counted> {
  const { rows } = await ctx.db.query(
    `SELECT ${isoTime("c.bucket")} AS bucket, c.events, sum(c.events) OVER () AS total FROM (SELECT ${truncate} AS bucket, count(*) AS events FROM ${relation} WHERE ${where} GROUP BY 1) c ORDER BY c.bucket`,
    params.values,
    ctx.signal
  )
  const observed = rows.map((row) => bucketRow.parse(row))
  const total = observed[0]?.total ?? 0
  const filled = fillBuckets(
    observed,
    grid.map((slot) => slot.start),
    (bucket) => ({ bucket, events: 0, total })
  )
  return {
    total,
    series: [],
    other: null,
    buckets: grid.map((slot, index) => ({
      bucket_start: slot.start,
      bucket_end: slot.end,
      partial: slot.partial,
      events: filled[index]?.events ?? 0,
      series: [],
      other_events: null,
    })),
  }
}

/**
 * Split trend. The CTE ranks every value by its events in scope (ties by
 * value, NULL last; dense_rank is unique because the order key includes the
 * value). Ranks above TREND_MAX_SERIES share the `other` slot. The first
 * query returns one row per series plus `other` with the scope total, the
 * second one row per bucket and slot with the bucket total.
 */
async function countSeries(
  ctx: Ctx,
  dimension: TrendDimension,
  truncate: string,
  relation: string,
  where: string,
  params: SqlParams,
  grid: readonly BucketSlot[]
): Promise<Counted> {
  const value = dimensionExpression(dimension, relation)
  const cte = `WITH cells AS (SELECT ${truncate} AS bucket, ${value} AS value, count(*) AS events FROM ${relation} WHERE ${where} GROUP BY 1, 2), ranked AS (SELECT bucket, value, events, dense_rank() OVER (ORDER BY value_events DESC, value ASC NULLS LAST) AS series_rank FROM (SELECT bucket, value, events, sum(events) OVER (PARTITION BY value) AS value_events FROM cells) t), slots AS (SELECT bucket, least(series_rank, ${OTHER_SLOT}) AS slot, CASE WHEN series_rank <= ${TREND_MAX_SERIES} THEN value END AS value, series_rank, events FROM ranked)`
  const seriesResult = await ctx.db.query(
    `${cte} SELECT slot, value, sum(events) AS events, count(DISTINCT series_rank) AS merged_values, sum(sum(events)) OVER () AS total FROM slots GROUP BY slot, value ORDER BY slot`,
    params.values,
    ctx.signal
  )
  const cellResult = await ctx.db.query(
    `${cte} SELECT ${isoTime("bucket")} AS bucket, slot, sum(events) AS events, sum(sum(events)) OVER (PARTITION BY bucket) AS bucket_events FROM slots GROUP BY bucket, slot ORDER BY bucket, slot`,
    params.values,
    ctx.signal
  )

  const ranked = seriesResult.rows.map((row) => seriesRow.parse(row))
  const total = ranked[0]?.total ?? 0
  const named = ranked.filter((row) => row.slot < OTHER_SLOT)
  const otherRow = ranked.find((row) => row.slot === OTHER_SLOT)
  const seriesOf = (events: number, row: { value: string | null }) => {
    const series: TrendSeries = { events }
    series[dimension] = row.value
    return series
  }

  // Group the cells by bucket; every bucket row repeats its total.
  const byBucket = new Map<
    bigint,
    { bucket: string; events: number; slots: Map<number, number> }
  >()
  for (const row of cellResult.rows.map((cell) => cellRow.parse(cell))) {
    const key = instantKey(row.bucket)
    const entry = byBucket.get(key) ?? {
      bucket: row.bucket,
      events: row.bucket_events,
      slots: new Map<number, number>(),
    }
    entry.slots.set(row.slot, row.events)
    byBucket.set(key, entry)
  }
  const filled = fillBuckets(
    [...byBucket.values()],
    grid.map((slot) => slot.start),
    (bucket) => ({ bucket, events: 0, slots: new Map<number, number>() })
  )

  return {
    total,
    series: named.map((row) => seriesOf(row.events, row)),
    other:
      otherRow === undefined
        ? null
        : { events: otherRow.events, merged_values: otherRow.merged_values },
    buckets: grid.map((slot, index) => {
      const cells = filled[index]
      return {
        bucket_start: slot.start,
        bucket_end: slot.end,
        partial: slot.partial,
        events: cells?.events ?? 0,
        series: named.map((row) =>
          seriesOf(cells?.slots.get(row.slot) ?? 0, row)
        ),
        other_events:
          otherRow === undefined ? null : (cells?.slots.get(OTHER_SLOT) ?? 0),
      }
    }),
  }
}

/**
 * Buckets in which the dataset has any event, regardless of the other
 * filters. A bucket without one is a capture gap: the logs have no data
 * there at all (concept 5.2), so its zero is not observed calm.
 */
async function capturedBuckets(
  ctx: Ctx,
  input: EventTrendInput,
  effective: TimeRange
): Promise<Set<bigint>> {
  const params = new SqlParams()
  const compiled = compileFilter(
    { dataset: input.dataset, from: effective.from, to: effective.to },
    { accepted: ["dataset", "from", "to"], params }
  )
  if (!compiled.ok) throw new Error("capture coverage filter rejected")
  const { relation, where } = compiled.filter
  const { rows } = await ctx.db.query(
    `SELECT ${isoTime("c.bucket")} AS bucket FROM (SELECT date_trunc('${bucketUnitSchema.parse(input.bucket)}', ${relation}.ts) AS bucket FROM ${relation} WHERE ${where} GROUP BY 1) c ORDER BY c.bucket`,
    params.values,
    ctx.signal
  )
  return new Set(rows.map((row) => instantKey(spanRowTimes.parse(row).bucket)))
}

/** Cross-field rules: the shared filter rules plus BGL-only split dimensions. */
function validateTrend(input: EventTrendInput): ToolError | null {
  const issues: InputIssue[] = []
  const filterError = validateFilter(input)
  if (filterError?.code === "invalid_input") issues.push(...filterError.issues)
  else if (filterError !== null) return filterError
  if (
    input.dataset === "openstack" &&
    input.split_by !== undefined &&
    BGL_ONLY_DIMENSIONS.includes(input.split_by)
  ) {
    issues.push({
      path: "split_by",
      message: `${input.split_by} exists only for dataset bgl.`,
    })
  }
  return issues.length === 0 ? null : invalidInput(issues)
}

/**
 * limit_exceeded with a hint the model can act on: the next coarser bucket
 * that fits, and the longest window that fits at this bucket size.
 */
function tooManyBuckets(
  effective: TimeRange,
  unit: BucketUnit,
  needed: number
): ToolError {
  const suggestions: string[] = []
  for (
    let coarser = COARSER[unit];
    coarser !== null;
    coarser = COARSER[coarser]
  ) {
    const count = bucketCount(effective, coarser)
    if (count <= TREND_MAX_BUCKETS) {
      suggestions.push(`Use bucket "${coarser}" (${count} buckets)`)
      break
    }
  }
  suggestions.push(
    `${suggestions.length === 0 ? "Narrow" : "narrow"} from/to to at most ${TREND_MAX_BUCKETS} ${unit}s inside the data span`
  )
  return {
    ...limitExceeded(
      `Buckets for [${effective.from}, ${effective.to}) by ${unit}`,
      TREND_MAX_BUCKETS,
      needed
    ),
    hint: `${suggestions.join(", or ")}.`,
  }
}

function factSpecsFor(input: EventTrendInput): readonly FactSpec[] {
  const dimension = input.split_by
  const times: FactSpec[] = [
    timeFact("/result/data_span/first", "data_span_start"),
    timeFact("/result/data_span/last", "data_span_end"),
    timeFact("/result/effective_range/from", "range_start"),
    timeFact("/result/effective_range/to", "range_end"),
    timeFact("/scope/windows/*/from", "window_start"),
    timeFact("/scope/windows/*/to", "window_end"),
  ]
  const counts: FactSpec[] = [
    {
      path: "/result/total",
      metric: "events",
      unit: "log_events",
      groupKeys: ["dataset"],
    },
    {
      path: "/result/bucket_count",
      metric: "buckets",
      unit: "buckets",
      groupKeys: ["dataset", "bucket"],
    },
    {
      path: "/result/buckets/*/events",
      metric: "events",
      unit: "log_events",
      groupKeys: ["dataset", "bucket_start"],
    },
  ]
  if (dimension === undefined) return [...counts, ...times]
  return [
    ...counts,
    {
      path: "/result/series/*/events",
      metric: "events",
      unit: "log_events",
      groupKeys: ["dataset", dimension],
    },
    {
      path: "/result/other/events",
      metric: "other_events",
      unit: "log_events",
      groupKeys: ["dataset"],
    },
    {
      path: "/result/other/merged_values",
      metric: "merged_values",
      unit: "dimension_values",
      groupKeys: ["dataset"],
    },
    {
      path: "/result/buckets/*/series/*/events",
      metric: "events",
      unit: "log_events",
      groupKeys: ["dataset", "bucket_start", dimension],
    },
    {
      path: "/result/buckets/*/other_events",
      metric: "other_events",
      unit: "log_events",
      groupKeys: ["dataset", "bucket_start"],
    },
    ...times,
  ]
}

function timeFact(path: string, metric: string): FactSpec {
  return { path, metric, unit: "utc_time", groupKeys: ["dataset"] }
}

function filterOf(input: EventTrendInput): Partial<Filter> {
  const filter: Partial<Filter> = { dataset: input.dataset }
  for (const field of TREND_FILTER.fields) {
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
  input: EventTrendInput,
  span: DataSpan,
  requested: TimeRange,
  effective: TimeRange,
  data: EventTrendOutput
): string[] {
  const notes = [BASE_NOTE]
  if (
    instantKey(requested.from) < instantKey(effective.from) ||
    instantKey(requested.to) > instantKey(effective.to)
  ) {
    notes.push(
      `The requested range [${requested.from}, ${requested.to}) reaches beyond the data span (${span.first} – ${span.last}); buckets cover only the effective range [${effective.from}, ${effective.to}). Time outside it has no data, which is not zero (R-03).`
    )
  }
  const partial = data.buckets.filter((bucket) => bucket.partial).length
  if (partial > 0) {
    notes.push(
      `${partial} bucket(s) marked partial cover less than a full ${input.bucket} because the effective range starts or ends inside them; a lower count there is no drop.`
    )
  }
  const gaps = data.buckets.filter((bucket) => bucket.capture_gap).length
  if (gaps > 0) {
    notes.push(
      `${gaps} bucket(s) marked capture_gap contain no ${input.dataset} event at all: the logs captured nothing there, so their zero is no observed calm. Buckets with only some captured time are not marked.`
    )
  }
  if (data.total === 0) {
    notes.push(
      "No log event matches the filters in the effective range; every bucket is a zero."
    )
  }
  if (data.other !== null) {
    notes.push(
      `Only the top ${TREND_MAX_SERIES} ${input.split_by ?? ""} values are series; ${data.other.merged_values} other value(s) are summed as other.`
    )
  }
  return notes
}
