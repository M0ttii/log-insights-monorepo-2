/** SQL rules are compared with the domain's independent test oracles only here. */
import {
  priorityDominance,
  type DominanceCandidate,
  type PriorityDominance,
} from "@workspace/domain/rules/dominance"
import {
  investigationOrder,
  rankLeaders,
  type Leaders,
} from "@workspace/domain/rules/ranking"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { createDatabase, type Database } from "../../src/db.ts"
import { SqlParams } from "../../src/sql.ts"
import {
  conflictRow,
  dimensions,
  investigationCtes,
  leaderRow,
  rankBasis,
  ruleRecords,
  ruleSummaryRow,
} from "../../src/tools/recurring-pattern-rules.ts"
import { loadEnv, samplesConnection } from "./helpers.ts"

loadEnv()
let db: Database
beforeAll(() => {
  db = createDatabase(samplesConnection())
})
afterAll(async () => {
  await db.dispose()
})

type Candidate = DominanceCandidate & { events: number }
const candidate = (
  pattern_id: string,
  episodes: number,
  breadth: number | null,
  change: number | null,
  events = episodes
): Candidate => ({ pattern_id, episodes, breadth, change, events })

const CASES: { name: string; candidates: Candidate[] }[] = [
  { name: "empty scope", candidates: [] },
  {
    name: "single candidate without optional dimensions",
    candidates: [candidate("only", 1, null, null)],
  },
  {
    name: "clear priority",
    candidates: [candidate("wide", 4, 4, 4), candidate("small", 2, 2, 2)],
  },
  {
    name: "equal dominance dimensions with different event counts",
    candidates: [candidate("a", 2, 3, 4, 8), candidate("b", 2, 3, 4, 100)],
  },
  {
    name: "negative increases",
    candidates: [candidate("a", 3, 1, -10), candidate("b", 2, 4, -1)],
  },
  {
    name: "missing breadth on the last candidate",
    candidates: [
      candidate("a", 3, 10, 5),
      candidate("b", 3, 1, 10),
      candidate("z", 1, null, 0),
    ],
  },
  {
    name: "missing increase",
    candidates: [candidate("a", 3, 1, 50), candidate("b", 2, 4, null)],
  },
  {
    name: "both optional dimensions dropped",
    candidates: [candidate("a", 2, 1, null), candidate("b", 2, null, 4)],
  },
  {
    name: "more tied leaders and outside conflicts than the caps",
    candidates: Array.from({ length: 9 }, (_, i) =>
      candidate(`tie_${i}`, 2, 3, 4, 8)
    ),
  },
  {
    name: "all listed pair conflicts followed by capped outside conflicts",
    candidates: Array.from({ length: 12 }, (_, i) =>
      candidate(
        `trade_${String(i).padStart(2, "0")}`,
        20 - i,
        i + 1,
        12 - i,
        40
      )
    ),
  },
]

async function sqlRules(candidates: readonly Candidate[], limit: number) {
  const params = new SqlParams()
  const values = candidates.map(
    (row) =>
      `(${params.add(row.pattern_id)}::VARCHAR, ${params.add(row.episodes)}::BIGINT, ${params.add(row.breadth)}::BIGINT, ${params.add(row.change)}::BIGINT, ${params.add(row.events)}::BIGINT)`
  )
  const ctes = [
    values.length === 0
      ? "WITH ruled AS (SELECT NULL::VARCHAR AS pattern_id, 0::BIGINT AS episodes, NULL::BIGINT AS b1, NULL::BIGINT AS delta, 0::BIGINT AS events WHERE FALSE)"
      : `WITH ruled AS (SELECT * FROM (VALUES ${values.join(", ")}) fixture(pattern_id, episodes, b1, delta, events))`,
    ", joined AS (SELECT * FROM ruled)",
    ", totals AS (SELECT coalesce(sum(events), 0)::BIGINT AS total, count(*) AS active, 0::BIGINT AS quiet FROM joined)",
    ...investigationCtes(params, limit),
  ]
  const sql = `${ctes.join("")}${ruleRecords(
    [
      ["pattern_id", "VARCHAR", "pattern_id"],
      ["total", "BIGINT", "(SELECT total FROM totals)"],
      ["active", "BIGINT", "(SELECT active FROM totals)"],
      ["quiet", "BIGINT", "(SELECT quiet FROM totals)"],
    ],
    params,
    true,
    limit
  )}`
  return (await db.query(sql, params.values, new AbortController().signal)).rows
}

const record = z.object({
  record_kind: z.string(),
  pattern_id: z.string().nullable(),
})

describe.each([1, 3, 5])(
  "R-08/R-09 SQL matches the domain oracles with limit %i",
  (limit) => {
    it.each(CASES)("$name", async ({ candidates }) => {
      const expected = investigationOrder(
        candidates.map((row) => ({ ...row, increase: row.change }))
      )
      const rows = await sqlRules(candidates, limit)
      const selected = rows.filter(
        (row) => record.parse(row).record_kind === "pattern"
      )
      expect(selected.map((row) => record.parse(row).pattern_id)).toEqual(
        expected.ranked.slice(0, limit).map((row) => row.pattern_id)
      )

      const summary = ruleSummaryRow.parse(
        rows.find((row) => record.parse(row).record_kind === "summary")
      )
      expect(summary.candidates_checked).toBe(candidates.length)
      expect(summary.truncated).toBe(candidates.length > limit)
      expect(rankBasis(summary)).toEqual(expected.basis)
      expect(summary.drop_breadth).toBe(expected.dropped.includes("breadth"))
      expect(summary.drop_increase).toBe(expected.dropped.includes("increase"))

      const leaders: Leaders = {
        episodes: null,
        breadth: null,
        increase: null,
        events: null,
      }
      for (const row of rows.filter(
        (item) => record.parse(item).record_kind === "leader"
      )) {
        const parsed = leaderRow.parse(row)
        const entry = leaders[parsed.criterion] ?? {
          value: parsed.value,
          tied: parsed.tied,
          pattern_ids: [],
        }
        entry.pattern_ids.push(parsed.pattern_id)
        leaders[parsed.criterion] = entry
      }
      expect(leaders).toEqual(rankLeaders(expected.ranked))
      const conflicts = rows
        .filter((row) => record.parse(row).record_kind === "conflict")
        .map((row) => conflictRow.parse(row))
      expect(summary.first_pattern_id).toBe(
        expected.ranked[0]?.pattern_id ?? null
      )
      const expectedDominance =
        candidates.length === 0
          ? null
          : priorityDominance(
              expected.ranked,
              Math.min(limit, candidates.length)
            )
      const actual: PriorityDominance | null =
        summary.first_pattern_id === null
          ? null
          : summary.not_dominated_by_first === 0
            ? {
                kind: "clear_priority",
                pattern_id: summary.first_pattern_id,
                compared_with: summary.compared_with,
                dimensions: dimensions(
                  !summary.drop_breadth,
                  !summary.drop_increase
                ),
              }
            : {
                kind: "trade_off",
                pattern_id: summary.first_pattern_id,
                not_dominated_by_first: summary.not_dominated_by_first,
                dimensions: dimensions(
                  !summary.drop_breadth,
                  !summary.drop_increase
                ),
                conflicts: conflicts.map((row) => ({
                  a: row.a,
                  b: row.b,
                  b_listed: row.b_listed,
                  a_ahead_in: [
                    ...(row.a_episodes ? ["episodes" as const] : []),
                    ...(row.a_breadth ? ["breadth" as const] : []),
                    ...(row.a_change ? ["change" as const] : []),
                  ],
                  b_ahead_in: [
                    ...(row.b_episodes ? ["episodes" as const] : []),
                    ...(row.b_breadth ? ["breadth" as const] : []),
                    ...(row.b_change ? ["change" as const] : []),
                  ],
                })),
              }
      expect(actual).toEqual(expectedDominance)
      expect(summary.not_dominated_by_first).toBe(
        expectedDominance?.kind === "trade_off"
          ? expectedDominance.not_dominated_by_first
          : 0
      )
      expect(conflicts).toHaveLength(
        expectedDominance?.kind === "trade_off"
          ? expectedDominance.conflicts.length
          : 0
      )
    })
  }
)
