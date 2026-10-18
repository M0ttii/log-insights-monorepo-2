import type { ToolContext } from "@workspace/domain/tool"
import type { LatencyStatsInput } from "@workspace/domain/tools/latency-stats"
import { latencyOutlierOutputSchema } from "@workspace/domain/tools/latency-stats"
import { z } from "zod"

import { exactCount, SqlParams } from "./sql.ts"

const outlierRow = z.object({
  baseline_values: exactCount,
  threshold_ms: z.number().nullable(),
  determinable: z.boolean(),
  outlier_events: exactCount.nullable(),
  rate: z.number().nullable(),
  event_id: exactCount.nullable(),
  latency_ms: z.number().nullable(),
  request_id: z.string().nullable(),
  exceeds_threshold: z.boolean().nullable(),
  case_found: z.boolean().nullable(),
  cases_truncated: z.boolean(),
})

/** Threshold, denominator and selected case all use the identical access population. */
export async function latencyOutliers(
  ctx: ToolContext,
  input: LatencyStatsInput,
  where: string,
  params: SqlParams
) {
  const selection = input.outliers
  if (selection === undefined)
    throw new Error("outlier analysis without selection")
  const quantile = selection.threshold === "p95" ? "0.95" : "0.99"
  const minimum = `${params.add(selection.min_baseline)}::BIGINT`
  const caseFilter =
    selection.case_event_id === undefined
      ? "TRUE"
      : `event_id = ${params.add(selection.case_event_id)}::BIGINT`
  const sql = `WITH base AS (SELECT event_id,latency_ms,request_id FROM log_events WHERE ${where} AND latency_ms IS NOT NULL), aggregate AS (SELECT count(*) AS baseline_values,quantile_cont(latency_ms,${quantile}) AS threshold FROM base), baseline AS (SELECT baseline_values, baseline_values >= ${minimum} AS determinable, CASE WHEN baseline_values >= ${minimum} THEN threshold END AS threshold_ms FROM aggregate), summary AS (SELECT baseline.*, CASE WHEN baseline.determinable THEN (SELECT count(*) FROM base WHERE latency_ms > baseline.threshold_ms) END AS outlier_events FROM baseline), selected AS (SELECT event_id,latency_ms,request_id FROM base WHERE ${caseFilter} ORDER BY latency_ms DESC,event_id ASC LIMIT 20) SELECT summary.*, CASE WHEN determinable THEN outlier_events::DOUBLE/nullif(baseline_values,0) END AS rate, selected.*,CASE WHEN determinable THEN latency_ms > threshold_ms END AS exceeds_threshold,${selection.case_event_id === undefined ? "NULL::BOOLEAN" : "EXISTS (SELECT 1 FROM selected)"} AS case_found, ${selection.case_event_id === undefined ? "baseline_values > 20" : "FALSE"} AS cases_truncated FROM summary LEFT JOIN selected ON TRUE ORDER BY latency_ms DESC NULLS LAST,event_id ASC`
  const { rows } = await ctx.db.query(sql, params.values, ctx.signal)
  const parsed = rows.map((row) => outlierRow.parse(row))
  const first = parsed[0]
  if (first === undefined) throw new Error("outlier analysis without summary")
  return latencyOutlierOutputSchema.parse({
    baseline_values: first.baseline_values,
    minimum_baseline: selection.min_baseline,
    threshold_ms: first.threshold_ms,
    threshold: selection.threshold,
    determinable: first.determinable,
    outlier_events: first.outlier_events,
    rate: first.rate,
    cases: parsed
      .filter((row) => row.event_id !== null)
      .map(({ event_id, latency_ms, request_id, exceeds_threshold }) => ({
        event_id,
        latency_ms,
        request_id,
        exceeds_threshold,
      })),
    case_found: first.case_found,
    cases_truncated: first.cases_truncated,
  })
}
