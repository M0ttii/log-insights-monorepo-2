import { toSafeInteger } from "@workspace/domain/bigint"
import {
  MAX_OUTSIDE_CONFLICTS,
  type DominanceDimension,
} from "@workspace/domain/rules/dominance"
import {
  MAX_LEADER_IDS,
  type RankCriterion,
} from "@workspace/domain/rules/ranking"
import { z } from "zod"

import { exactCount, SqlParams } from "../sql.ts"

/** R-08/R-09 see every current candidate; only the records leaving SQL are capped. */
export function investigationCtes(params: SqlParams, limit: number): string[] {
  const listed = `${params.add(limit)}::BIGINT`
  const outsideLimit = `${params.add(MAX_OUTSIDE_CONFLICTS)}::BIGINT`
  return [
    ", candidates AS (SELECT * FROM ruled WHERE events > 0)",
    ", availability AS (SELECT count(*) AS candidates_checked, coalesce(count_if(b1 IS NULL), 0) AS missing_breadth, coalesce(count_if(delta IS NULL), 0) > 0 AS drop_increase, coalesce(count_if(b1 IS NULL), 0) > 0 AS drop_breadth FROM candidates)",
    ", ranked AS (SELECT candidates.*, row_number() OVER (ORDER BY episodes DESC, CASE WHEN NOT drop_breadth THEN b1 END DESC, CASE WHEN NOT drop_increase THEN delta END DESC, events DESC, pattern_id ASC) AS rank FROM candidates CROSS JOIN availability)",
    ", first_candidate AS (SELECT * FROM ranked WHERE rank = 1)",
    // Equality is a trade-off, even when events (outside R-09) differ.
    `, first_comparisons AS (SELECT b.pattern_id, b.rank, ${dominates("a", "b")} AS first_dominates FROM first_candidate a CROSS JOIN ranked b CROSS JOIN availability WHERE b.rank > 1)`,
    ", dominance_summary AS (SELECT coalesce(count_if(NOT first_dominates), 0) AS not_dominated_by_first FROM first_comparisons)",
    `, listed_conflicts AS (SELECT a.pattern_id AS a, b.pattern_id AS b, a.rank AS a_rank, b.rank AS b_rank, ${ahead("a", "b")}, TRUE AS b_listed, 0 AS section FROM ranked a JOIN ranked b ON a.rank < b.rank CROSS JOIN availability WHERE b.rank <= ${listed} AND NOT (${dominates("a", "b")}) AND NOT (${dominates("b", "a")}))`,
    `, outside_candidates AS (SELECT pattern_id, rank, row_number() OVER (ORDER BY rank, pattern_id) AS conflict_rank FROM first_comparisons WHERE NOT first_dominates AND rank > ${listed})`,
    `, outside_conflicts AS (SELECT a.pattern_id AS a, b.pattern_id AS b, a.rank AS a_rank, b.rank AS b_rank, ${ahead("a", "b")}, FALSE AS b_listed, 1 AS section FROM first_candidate a CROSS JOIN ranked b JOIN outside_candidates o ON b.pattern_id = o.pattern_id CROSS JOIN availability WHERE o.conflict_rank <= ${outsideLimit})`,
    ", conflicts AS (SELECT * FROM listed_conflicts UNION ALL SELECT * FROM outside_conflicts)",
    // Relational rows avoid driver-specific LIST/JSON values. SQL determines
    // both the full tie count and the bounded list of leader IDs.
    ", leader_values AS (SELECT 'episodes' AS criterion, pattern_id, rank, episodes AS value FROM ranked UNION ALL SELECT 'breadth', pattern_id, rank, b1 FROM ranked CROSS JOIN availability WHERE NOT drop_breadth UNION ALL SELECT 'increase', pattern_id, rank, delta FROM ranked CROSS JOIN availability WHERE NOT drop_increase UNION ALL SELECT 'events', pattern_id, rank, events FROM ranked)",
    ", leader_maxima AS (SELECT *, max(value) OVER (PARTITION BY criterion) AS best FROM leader_values)",
    ", leaders AS (SELECT *, count(*) OVER (PARTITION BY criterion) AS tied, row_number() OVER (PARTITION BY criterion ORDER BY rank, pattern_id) AS leader_rank FROM leader_maxima WHERE value = best)",
  ]
}

function dominates(a: string, b: string): string {
  return `(${a}.episodes >= ${b}.episodes AND (drop_breadth OR ${a}.b1 >= ${b}.b1) AND (drop_increase OR ${a}.delta >= ${b}.delta) AND (${a}.episodes > ${b}.episodes OR (NOT drop_breadth AND ${a}.b1 > ${b}.b1) OR (NOT drop_increase AND ${a}.delta > ${b}.delta)))`
}

function ahead(a: string, b: string): string {
  return `${a}.episodes > ${b}.episodes AS a_episodes, NOT drop_breadth AND ${a}.b1 > ${b}.b1 AS a_breadth, NOT drop_increase AND ${a}.delta > ${b}.delta AS a_change, ${b}.episodes > ${a}.episodes AS b_episodes, NOT drop_breadth AND ${b}.b1 > ${a}.b1 AS b_breadth, NOT drop_increase AND ${b}.delta > ${a}.delta AS b_change`
}

export type RecordColumn = readonly [
  name: string,
  type: string,
  expression: string,
]

type RecordSelection = {
  kind: string
  values: Readonly<Record<string, string>>
  from: string
}

const RULE_COLUMNS: readonly RecordColumn[] = [
  ["candidates_checked", "BIGINT", "NULL"],
  ["missing_breadth", "BIGINT", "NULL"],
  ["drop_breadth", "BOOLEAN", "NULL"],
  ["drop_increase", "BOOLEAN", "NULL"],
  ["not_dominated_by_first", "BIGINT", "NULL"],
  ["first_pattern_id", "VARCHAR", "NULL"],
  ["compared_with", "BIGINT", "NULL"],
  ["truncated", "BOOLEAN", "NULL"],
  ["qualifying", "BIGINT", "NULL"],
  ["criterion", "VARCHAR", "NULL"],
  ["value", "BIGINT", "NULL"],
  ["tied", "BIGINT", "NULL"],
  ["a", "VARCHAR", "NULL"],
  ["b", "VARCHAR", "NULL"],
  ["a_episodes", "BOOLEAN", "NULL"],
  ["a_breadth", "BOOLEAN", "NULL"],
  ["a_change", "BOOLEAN", "NULL"],
  ["b_episodes", "BOOLEAN", "NULL"],
  ["b_breadth", "BOOLEAN", "NULL"],
  ["b_change", "BOOLEAN", "NULL"],
  ["b_listed", "BOOLEAN", "NULL"],
]

/** Flat, explicitly typed records keep pg metadata and receipt rows reproducible. */
export function ruleRecords(
  columns: readonly RecordColumn[],
  params: SqlParams,
  investigating: boolean,
  limit: number
): string {
  const listed = `${params.add(limit)}::BIGINT`
  const selections: RecordSelection[] = [
    {
      kind: "pattern",
      values: {
        ...Object.fromEntries(
          columns.map(([name, , expression]) => [name, expression])
        ),
        sort_a: "rank",
      },
      from: `FROM ranked WHERE rank <= ${listed}`,
    },
  ]
  if (investigating) {
    const leaderLimit = `${params.add(MAX_LEADER_IDS)}::BIGINT`
    selections.push(
      {
        kind: "summary",
        values: {
          candidates_checked: "candidates_checked",
          missing_breadth: "missing_breadth",
          drop_breadth: "drop_breadth",
          drop_increase: "drop_increase",
          not_dominated_by_first: "not_dominated_by_first",
          first_pattern_id: "(SELECT pattern_id FROM first_candidate)",
          compared_with: "greatest(candidates_checked - 1, 0)",
          truncated: `candidates_checked > ${listed}`,
          qualifying: "candidates_checked",
          total: "(SELECT total FROM totals)::BIGINT",
          active: "candidates_checked",
          quiet: "(SELECT quiet FROM totals)::BIGINT",
        },
        from: "FROM availability CROSS JOIN dominance_summary",
      },
      {
        kind: "leader",
        values: {
          pattern_id: "pattern_id",
          criterion: "criterion",
          value: "value",
          tied: "tied",
          sort_a: "rank",
        },
        from: `FROM leaders WHERE leader_rank <= ${leaderLimit}`,
      },
      {
        kind: "conflict",
        values: {
          ...Object.fromEntries(
            [
              "a",
              "b",
              "a_episodes",
              "a_breadth",
              "a_change",
              "b_episodes",
              "b_breadth",
              "b_change",
              "b_listed",
            ].map((name) => [name, name])
          ),
          sort_section: "section",
          sort_a: "a_rank",
          sort_b: "b_rank",
        },
        from: "FROM conflicts CROSS JOIN dominance_summary WHERE not_dominated_by_first > 0",
      }
    )
  } else {
    selections.push({
      kind: "summary",
      values: {
        total: "total",
        active: "active",
        quiet: "quiet",
        truncated: `active + quiet > ${listed}`,
        qualifying: "active + quiet",
      },
      from: "FROM totals",
    })
  }
  const fields: readonly RecordColumn[] = [
    ...columns,
    ...RULE_COLUMNS,
    ["sort_section", "BIGINT", "0"],
    ["sort_a", "BIGINT", "0"],
    ["sort_b", "BIGINT", "0"],
  ]
  const selects = selections.map(({ kind, values, from }) => {
    const projection = fields.map(
      ([name, type]) => `${values[name] ?? `NULL::${type}`} AS ${name}`
    )
    return `SELECT '${kind}' AS record_kind, ${projection.join(", ")} ${from}`
  })
  return ` SELECT * FROM (${selects.join(" UNION ALL ")}) records ORDER BY record_kind, sort_section, sort_a, sort_b, criterion, pattern_id, a, b`
}

const integer = z.union([z.string(), z.number()]).transform(toSafeInteger)

export const ruleSummaryRow = z.object({
  record_kind: z.literal("summary"),
  candidates_checked: exactCount,
  missing_breadth: exactCount,
  drop_breadth: z.boolean(),
  drop_increase: z.boolean(),
  not_dominated_by_first: exactCount,
  first_pattern_id: z.string().nullable(),
  compared_with: exactCount,
  truncated: z.boolean(),
})

export const leaderRow = z.object({
  record_kind: z.literal("leader"),
  pattern_id: z.string(),
  criterion: z.enum(["episodes", "breadth", "increase", "events"]),
  value: integer,
  tied: exactCount,
})

export const conflictRow = z.object({
  record_kind: z.literal("conflict"),
  a: z.string(),
  b: z.string(),
  a_episodes: z.boolean(),
  a_breadth: z.boolean(),
  a_change: z.boolean(),
  b_episodes: z.boolean(),
  b_breadth: z.boolean(),
  b_change: z.boolean(),
  b_listed: z.boolean(),
})

/** Serialization of SQL's dimension availability in the contract's fixed order. */
export function dimensions(
  breadth: boolean,
  change: boolean
): DominanceDimension[] {
  return [
    "episodes",
    ...(breadth ? ["breadth" as const] : []),
    ...(change ? ["change" as const] : []),
  ]
}

export function rankBasis(
  summary: z.infer<typeof ruleSummaryRow>
): RankCriterion[] {
  return [
    "episodes",
    ...(summary.drop_breadth ? [] : ["breadth" as const]),
    ...(summary.drop_increase ? [] : ["increase" as const]),
    "events",
    "pattern_id",
  ]
}
