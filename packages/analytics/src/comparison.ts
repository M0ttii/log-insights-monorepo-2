import type { ComparisonCoverage } from "@workspace/domain/rules/compare"
import type { DataSpan, TimeRange } from "@workspace/domain/time"
import type { ToolContext } from "@workspace/domain/tool"
import { z } from "zod"

const coverageSchema = z.enum(["full", "partial", "none"])
const comparisonRow = z.object({
  current: coverageSchema,
  baseline: coverageSchema,
  determinable: z.boolean(),
})

function coverageCase(from: string, to: string): string {
  return `CASE WHEN ${to} <= first_ts OR ${from} >= end_ts THEN 'none' WHEN ${from} >= first_ts AND ${to} <= end_ts THEN 'full' ELSE 'partial' END`
}

/** R-03/R-06 coverage, including the last observed microsecond, computed by SQL. */
export async function comparisonCoverageSql(
  ctx: Pick<ToolContext, "db" | "signal">,
  current: TimeRange,
  baseline: TimeRange,
  span: DataSpan
): Promise<ComparisonCoverage> {
  const { rows } = await ctx.db.query(
    `WITH comparison_bounds AS (SELECT $1::TIMESTAMPTZ AS cf, $2::TIMESTAMPTZ AS ct, $3::TIMESTAMPTZ AS bf, $4::TIMESTAMPTZ AS bt, $5::TIMESTAMPTZ AS first_ts, $6::TIMESTAMPTZ + INTERVAL '1 microsecond' AS end_ts), comparison_coverage AS (SELECT ${coverageCase("cf", "ct")} AS current, ${coverageCase("bf", "bt")} AS baseline FROM comparison_bounds) SELECT current, baseline, current <> 'none' AND baseline <> 'none' AS determinable FROM comparison_coverage`,
    [
      current.from,
      current.to,
      baseline.from,
      baseline.to,
      span.first,
      span.last,
    ],
    ctx.signal
  )
  return comparisonRow.parse(rows[0])
}
