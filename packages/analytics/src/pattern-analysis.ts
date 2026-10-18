import type { ToolContext } from "@workspace/domain/tool"
import type { TimeRange } from "@workspace/domain/time"
import {
  RECURRING_FILTER,
  patternAnalysisOutputSchema,
  type RecurringPatternsInput,
} from "@workspace/domain/tools/recurring-patterns"
import { z } from "zod"

import { compileFilter } from "./filters.ts"
import { exactCount, SqlParams } from "./sql.ts"

const periodicRow = z.object({
  occurrences: exactCount,
  gaps: exactCount,
  median_gap_seconds: z.number().nullable(),
  min_gap_seconds: z.number().nullable(),
  max_gap_seconds: z.number().nullable(),
  coefficient_of_variation: z.number().nullable(),
  determinable: z.boolean(),
})
const pairRow = z.object({
  anchors: exactCount,
  matched_anchors: exactCount,
  rate: z.number().nullable(),
  control_anchors: exactCount.nullable(),
  control_matched_anchors: exactCount.nullable(),
  control_rate: z.number().nullable(),
  rate_difference: z.number().nullable(),
})

/** Temporal observations only; R-05/R-08/R-09 calculations are untouched. */
export async function patternAnalysis(
  ctx: ToolContext,
  input: RecurringPatternsInput,
  window: TimeRange
) {
  const analysis = input.analysis
  if (analysis === undefined)
    throw new Error("pattern analysis without selection")
  const params = new SqlParams()
  const compiled = compileFilter(
    { ...input, ...window },
    { accepted: ["dataset", ...RECURRING_FILTER.fields], params }
  )
  if (!compiled.ok)
    throw new Error("validated pattern analysis filter rejected")
  const { rel, where } = compiled.filter
  const base = `WITH base AS (SELECT ${rel.col("event_id")} AS event_id, ${rel.col("ts")} AS ts, ${rel.col("pattern_id")} AS pattern_id FROM ${rel.from} WHERE ${where})`
  if (analysis.mode === "periodicity") {
    const pattern = `${params.add(analysis.pattern_id)}::VARCHAR`
    const minimum = `${params.add(analysis.min_occurrences)}::BIGINT`
    const sql = `${base}, ordered AS (SELECT ts, lag(ts) OVER (ORDER BY ts,event_id) AS previous FROM base WHERE pattern_id = ${pattern}), gaps AS (SELECT (epoch_us(ts) - epoch_us(previous))::DOUBLE / 1000000 AS gap FROM ordered), aggregate AS (SELECT count(*) AS occurrences, count(gap) AS gaps, quantile_cont(gap,0.5) AS median_gap_seconds, min(gap) AS min_gap_seconds,max(gap) AS max_gap_seconds,stddev_pop(gap) / nullif(avg(gap),0) AS coefficient_of_variation, count(*) >= ${minimum} AND avg(gap) > 0 AS determinable FROM gaps) SELECT occurrences,gaps,CASE WHEN determinable THEN median_gap_seconds END AS median_gap_seconds,CASE WHEN determinable THEN min_gap_seconds END AS min_gap_seconds,CASE WHEN determinable THEN max_gap_seconds END AS max_gap_seconds,CASE WHEN determinable THEN coefficient_of_variation END AS coefficient_of_variation,coalesce(determinable,false) AS determinable FROM aggregate`
    const { rows } = await ctx.db.query(sql, params.values, ctx.signal)
    return patternAnalysisOutputSchema.parse({
      mode: analysis.mode,
      pattern_id: analysis.pattern_id,
      ...periodicRow.parse(rows[0]),
      minimum_occurrences: analysis.min_occurrences,
      scope_unit: "log_events",
      uncertainty:
        "Consecutive occurrence gaps describe this filtered window only. A small or irregular sample, missing capture and timestamp precision limit periodicity; regular spacing does not establish a cause.",
    })
  }
  const a = `${params.add(analysis.pattern_a)}::VARCHAR`
  const b = `${params.add(analysis.pattern_b)}::VARCHAR`
  const control =
    analysis.control_pattern_id === undefined
      ? null
      : `${params.add(analysis.control_pattern_id)}::VARCHAR`
  const width = `${params.add(analysis.window_seconds)}::DOUBLE * 1000000`
  const distance =
    analysis.direction === "after"
      ? `epoch_us(b.ts) > epoch_us(a.ts) AND epoch_us(b.ts) - epoch_us(a.ts) <= ${width}`
      : `abs(epoch_us(b.ts)-epoch_us(a.ts)) <= ${width}`
  const sql = `${base}, anchors AS (SELECT a.pattern_id, EXISTS (SELECT 1 FROM base b WHERE b.pattern_id = ${b} AND b.event_id <> a.event_id AND ${distance}) AS matched FROM base a WHERE a.pattern_id = ${a}${control === null ? "" : ` OR a.pattern_id = ${control}`}), aggregate AS (SELECT count(*) FILTER (WHERE pattern_id = ${a}) AS anchors,count(*) FILTER (WHERE pattern_id = ${a} AND matched) AS matched_anchors,${control === null ? "NULL::BIGINT AS control_anchors,NULL::BIGINT AS control_matched_anchors" : `count(*) FILTER (WHERE pattern_id = ${control}) AS control_anchors,count(*) FILTER (WHERE pattern_id = ${control} AND matched) AS control_matched_anchors`} FROM anchors), rates AS (SELECT *,matched_anchors::DOUBLE/nullif(anchors,0) AS rate,control_matched_anchors::DOUBLE/nullif(control_anchors,0) AS control_rate FROM aggregate) SELECT *,rate-control_rate AS rate_difference FROM rates`
  const { rows } = await ctx.db.query(sql, params.values, ctx.signal)
  return patternAnalysisOutputSchema.parse({
    ...analysis,
    identity_scope: "all_events_in_filtered_dataset",
    control_pattern_id: analysis.control_pattern_id ?? null,
    ...pairRow.parse(rows[0]),
    scope_unit: "log_events",
    uncertainty:
      "Temporal co-occurrence/order within the stated window is an observation, never causal proof. Rates count distinct anchors; one target can match multiple anchors. A missing/empty control population leaves its rate and rate difference unknown.",
  })
}
