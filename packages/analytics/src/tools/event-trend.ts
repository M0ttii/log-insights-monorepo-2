import { toSafeInteger } from "@workspace/domain/bigint"
import {
  invalidInput,
  limitExceeded,
  type InputIssue,
  type ToolError,
} from "@workspace/domain/errors"
import type { FactSpec } from "@workspace/domain/facts"
import {
  DATASETS,
  isExternal,
  REMOTE_SCAN_MAX_SECONDS,
} from "@workspace/domain/datasets"
import {
  patternsUnsupported,
  remoteScanError,
  validateFilter,
  type Filter,
} from "@workspace/domain/filters"
import type { ReceiptSource } from "@workspace/domain/receipt"
import {
  bucketCount,
  bucketUnitSchema,
  effectiveRange,
  instantSchema,
  parseInstant,
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
  trendDimensionDatasets,
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

import { requireDataSpan } from "../corpus.ts"
import { compileFilter, dimensionExpression } from "../filters.ts"
import type { Relation } from "../relations.ts"
import { openReference, openScan, remoteNotes } from "../remote.ts"
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
 * grid, missing bucket/series zeros, partial edges and capture gaps are
 * computed by native range() and LEFT JOINs in SQL.
 */

/** log_events datasets: compileFilter picks the table or its index. */
const noRelation = (): Relation | undefined => undefined

/** Slot of `other` in the series query: one past the last named series. */
const OTHER_SLOT = TREND_MAX_SERIES + 1

const COARSER: Record<BucketUnit, BucketUnit | null> = {
  second: "minute",
  minute: "hour",
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

const gridRow = z.object({
  bucket: instantSchema,
  bucket_end: instantSchema,
  partial: z.boolean(),
  capture_gap: z.boolean(),
})
type GridRow = z.infer<typeof gridRow>
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
  slot: exactCount.nullable(),
  events: exactCount,
  bucket_events: exactCount,
})

export const eventTrend = defineTool({
  name: "event_trend",
  title: "Event trend",
  version: "1.2.0",
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
    inputs: `dataset (required, exactly one loaded dataset; no two datasets share a time axis, so call once per dataset), bucket (hour | day | week; weeks start on Monday 00:00 UTC), from/to as ISO-8601 with Z or offset, [from, to), default the whole data span, split_by (optional, one of ${TREND_DIMENSIONS.join(", ")}; alert_label, rack and node only for bgl, host for openssh and linux, client_ip for openssh and apache, thread for zookeeper, block_id for hdfs). At most ${TREND_MAX_BUCKETS} buckets per call: a longer range fails with limit_exceeded, whose hint names the next coarser bucket or a shorter window. dataset otel (remote OpenTelemetry Parquet): bucket second or minute; without text a direct scan of the remote files, from and to required and at most ${REMOTE_SCAN_MAX_SECONDS} s apart; with text the indexed reference window only; split_by team, component or level; source_changed when a remote file no longer matches its load-time pin.`,
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
    // otel (LOG-35) reads the reference index (text) or a bounded direct
    // scan; every statement builds its own relation, because a scan binds
    // its per-file bounds into the statement's parameters.
    let span: DataSpan
    let requested: TimeRange
    let source: ReceiptSource | undefined
    let relationFor: (params: SqlParams) => Relation | undefined = noRelation
    if (isExternal(input.dataset)) {
      if (input.text !== undefined) {
        const opened = await openReference(
          ctx.db,
          input,
          "A text condition",
          ctx.signal
        )
        if (!opened.ok) return opened
        const { rel, window } = opened.opened
        const required = await requireDataSpan(
          ctx.db,
          input.dataset,
          ctx.signal
        )
        if (!required.ok) return required
        span = required.span
        requested = { from: window.from, to: window.to }
        source = opened.opened.source
        relationFor = () => rel
      } else {
        const { from, to } = input
        if (from === undefined || to === undefined)
          throw new Error("direct scan without window passed validation")
        const opened = await openScan(ctx.db, { from, to }, ctx.signal)
        if (!opened.ok) return opened
        span = opened.opened.span
        requested = { from, to }
        source = opened.opened.source
        relationFor = (params) => opened.opened.relation(params)
      }
    } else {
      const resolved = await resolveWindows(
        ctx.db,
        [input.dataset],
        input,
        ctx.signal
      )
      if (!resolved.ok) return resolved
      const [first] = resolved.windows
      if (first === undefined) throw new Error("no window for the dataset")
      span = first.span
      requested = { from: first.window.from, to: first.window.to }
    }
    const effective = effectiveRange(requested, span)
    const filters = scopeFilters(input, TREND_FILTER.fields)
    const splitBy = input.split_by ?? null
    const remote = source === undefined ? [] : remoteNotes(source.path)
    const withSource = source === undefined ? {} : { source }

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
            ...remote,
          ],
          ...withSource,
        },
      }
    }

    const needed = bucketCount(effective, input.bucket)
    if (needed > TREND_MAX_BUCKETS)
      return {
        ok: false,
        error: tooManyBuckets(effective, input.bucket, needed),
      }
    const grid = await bucketGridSql(ctx, input, effective, relationFor)
    const params = new SqlParams()
    const rel = relationFor(params)
    const compiled = compileFilter(
      {
        ...filterOf(input),
        // A direct scan carries its window in the per-file bounds.
        ...(rel !== undefined && !rel.indexed
          ? {}
          : { from: effective.from, to: effective.to }),
      },
      {
        accepted: ["dataset", ...TREND_FILTER.fields],
        params,
        ...(rel === undefined ? {} : { relation: rel }),
      }
    )
    if (!compiled.ok) return compiled
    const { where } = compiled.filter
    const relation = compiled.filter.rel
    const truncate = relation.bucket(bucketUnitSchema.parse(input.bucket))

    const counted =
      splitBy === null
        ? await countBuckets(
            ctx,
            truncate,
            relation,
            where,
            params,
            grid,
            effective,
            input.bucket
          )
        : await countSeries(
            ctx,
            splitBy,
            truncate,
            relation,
            where,
            params,
            grid,
            effective,
            input.bucket
          )

    const { buckets } = counted
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
        notes: [
          ...notesFor(input, span, requested, effective, data),
          ...remote,
        ],
        ...withSource,
      },
    }
  },
})

type Counted = {
  total: number
  series: TrendSeries[]
  other: EventTrendOutput["other"]
  buckets: TrendBucket[]
}

type Ctx = Pick<ToolContext, "db" | "signal">

/** Bucket totals without split_by: one row per bucket with events, plus the total over all rows. */
async function countBuckets(
  ctx: Ctx,
  truncate: string,
  relation: Relation,
  where: string,
  params: SqlParams,
  grid: readonly GridRow[],
  effective: TimeRange,
  unit: BucketUnit
): Promise<Counted> {
  const { rows } = await ctx.db.query(
    `WITH ${gridCte(params, effective, unit)}, counted AS (SELECT ${truncate} AS bucket, count(*) AS events FROM ${relation.from} WHERE ${where} GROUP BY 1) SELECT ${isoTime("g.bucket")} AS bucket, coalesce(c.events, 0)::BIGINT AS events, sum(coalesce(c.events, 0)) OVER ()::BIGINT AS total FROM grid g LEFT JOIN counted c ON g.bucket = c.bucket ORDER BY g.bucket`,
    params.values,
    ctx.signal
  )
  const observed = rows.map((row) => bucketRow.parse(row))
  const total = observed[0]?.total ?? 0
  return {
    total,
    series: [],
    other: null,
    buckets: grid.map((slot, index) => {
      const row = observed[index]
      if (row === undefined) throw new Error("SQL omitted a bucket in the grid")
      return {
        bucket_start: slot.bucket,
        bucket_end: slot.bucket_end,
        partial: slot.partial,
        capture_gap: slot.capture_gap,
        events: row.events,
        series: [],
        other_events: null,
      }
    }),
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
  relation: Relation,
  where: string,
  params: SqlParams,
  grid: readonly GridRow[],
  effective: TimeRange,
  unit: BucketUnit
): Promise<Counted> {
  const value = dimensionExpression(dimension, relation)
  const cte = `WITH ${gridCte(params, effective, unit)}, cells AS (SELECT ${truncate} AS bucket, ${value} AS value, count(*) AS events FROM ${relation.from} WHERE ${where} GROUP BY 1, 2), ranked AS (SELECT bucket, value, events, dense_rank() OVER (ORDER BY value_events DESC, value ASC NULLS LAST) AS series_rank FROM (SELECT bucket, value, events, sum(events) OVER (PARTITION BY value) AS value_events FROM cells) t), slots AS (SELECT bucket, least(series_rank, ${OTHER_SLOT}) AS slot, CASE WHEN series_rank <= ${TREND_MAX_SERIES} THEN value END AS value, series_rank, events FROM ranked)`
  const seriesResult = await ctx.db.query(
    `${cte} SELECT slot, value, sum(events) AS events, count(DISTINCT series_rank) AS merged_values, sum(sum(events)) OVER () AS total FROM slots GROUP BY slot, value ORDER BY slot`,
    params.values,
    ctx.signal
  )
  const cellResult = await ctx.db.query(
    `${cte}, slot_totals AS (SELECT bucket, slot, sum(events) AS events FROM slots GROUP BY bucket, slot), named_slots AS (SELECT DISTINCT slot FROM slots), completed AS (SELECT g.bucket, n.slot, coalesce(c.events, 0)::BIGINT AS events FROM grid g LEFT JOIN named_slots n ON TRUE LEFT JOIN slot_totals c ON c.bucket = g.bucket AND c.slot = n.slot) SELECT ${isoTime("bucket")} AS bucket, slot, events, sum(events) OVER (PARTITION BY bucket)::BIGINT AS bucket_events FROM completed ORDER BY bucket, slot`,
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
    { events: number; slots: Map<number, number> }
  >()
  for (const row of cellResult.rows.map((cell) => cellRow.parse(cell))) {
    const key = instantKey(row.bucket)
    const entry = byBucket.get(key) ?? {
      events: row.bucket_events,
      slots: new Map<number, number>(),
    }
    if (row.slot !== null) entry.slots.set(row.slot, row.events)
    byBucket.set(key, entry)
  }

  return {
    total,
    series: named.map((row) => seriesOf(row.events, row)),
    other:
      otherRow === undefined
        ? null
        : { events: otherRow.events, merged_values: otherRow.merged_values },
    buckets: grid.map((slot) => {
      const cells = byBucket.get(instantKey(slot.bucket))
      if (cells === undefined)
        throw new Error("SQL omitted a bucket in the grid")
      const cellEvents = (key: number) => {
        const events = cells.slots.get(key)
        if (events === undefined)
          throw new Error("SQL omitted a series cell in the grid")
        return events
      }
      return {
        bucket_start: slot.bucket,
        bucket_end: slot.bucket_end,
        partial: slot.partial,
        capture_gap: slot.capture_gap,
        events: cells.events,
        series: named.map((row) => seriesOf(cellEvents(row.slot), row)),
        other_events: otherRow === undefined ? null : cellEvents(OTHER_SLOT),
      }
    }),
  }
}

/**
 * Buckets in which the dataset has any event, regardless of the other
 * filters. A bucket without one is a capture gap: the logs have no data
 * there at all (concept 5.2), so its zero is not observed calm.
 */
async function bucketGridSql(
  ctx: Ctx,
  input: EventTrendInput,
  effective: TimeRange,
  relationFor: (params: SqlParams) => Relation | undefined
): Promise<GridRow[]> {
  const params = new SqlParams()
  const rel = relationFor(params)
  const compiled = compileFilter(
    rel !== undefined && !rel.indexed
      ? { dataset: input.dataset }
      : { dataset: input.dataset, from: effective.from, to: effective.to },
    {
      accepted: ["dataset", "from", "to"],
      params,
      ...(rel === undefined ? {} : { relation: rel }),
    }
  )
  if (!compiled.ok) throw new Error("capture coverage filter rejected")
  const relation = compiled.filter.rel
  const { where } = compiled.filter
  const { rows } = await ctx.db.query(
    `WITH ${gridCte(params, effective, input.bucket)}, captured AS (SELECT ${relation.bucket(bucketUnitSchema.parse(input.bucket))} AS bucket FROM ${relation.from} WHERE ${where} GROUP BY 1) SELECT ${isoTime("g.bucket")} AS bucket, ${isoTime(`g.bucket + ${params.add(`1 ${input.bucket}`)}::INTERVAL`)} AS bucket_end, g.bucket < ${params.add(effective.from)}::TIMESTAMPTZ OR g.bucket + ${params.add(`1 ${input.bucket}`)}::INTERVAL > ${params.add(effective.to)}::TIMESTAMPTZ AS partial, c.bucket IS NULL AS capture_gap FROM grid g LEFT JOIN captured c ON g.bucket = c.bucket ORDER BY g.bucket`,
    params.values,
    ctx.signal
  )
  return rows.map((row) => gridRow.parse(row))
}

/** Half-open native timestamp range: only buckets overlapping the effective span. */
function gridCte(
  params: SqlParams,
  effective: TimeRange,
  unit: BucketUnit
): string {
  const from = params.add(effective.from)
  const to = params.add(effective.to)
  const step = params.add(`1 ${unit}`)
  // A parameterized range() table function is described as unknown on
  // 26.10.1; scalar range() + unnest() preserves the TIMESTAMPTZ metadata.
  return `grid AS (SELECT unnest(range(date_trunc('${bucketUnitSchema.parse(unit)}', ${from}::TIMESTAMPTZ), ${to}::TIMESTAMPTZ, ${step}::INTERVAL)) AS bucket)`
}

/** Cross-field rules: the shared filter rules plus dataset-specific split dimensions. */
function validateTrend(input: EventTrendInput): ToolError | null {
  const issues: InputIssue[] = []
  const filterError = validateFilter(input)
  if (filterError?.code === "invalid_input") issues.push(...filterError.issues)
  else if (filterError !== null) return filterError
  if (input.split_by === "pattern" && !DATASETS[input.dataset].patterns)
    issues.push(patternsUnsupported(input.dataset, "split_by"))
  // Remote datasets (LOG-35): a bounded direct scan without text.
  const scan = remoteScanError(input)
  if (scan?.code === "invalid_input") issues.push(...scan.issues)
  else if (scan !== null && issues.length === 0) return scan
  const datasets =
    input.split_by === undefined ? null : trendDimensionDatasets(input.split_by)
  if (datasets !== null && !datasets.includes(input.dataset)) {
    issues.push({
      path: "split_by",
      message: `${input.split_by} exists only for ${datasets.length === 1 ? "dataset" : "datasets"} ${datasets.join(", ")}.`,
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
