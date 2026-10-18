/** Author: independent LOG-41 verifier, not the analytical tool implementer.
 * Full-corpus references deliberately scan log_events, not tool SQL/index helpers.
 */
import { countEventsOutputSchema } from "@workspace/domain/tools/count-events"
import { latencyStatsOutputSchema } from "@workspace/domain/tools/latency-stats"
import { recurringPatternsOutputSchema } from "@workspace/domain/tools/recurring-patterns"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { createGoldenHarness, expectClose, integer } from "./helpers.ts"

let harness: Awaited<ReturnType<typeof createGoldenHarness>>
beforeAll(async () => {
  harness = await createGoldenHarness()
})
afterAll(async () => {
  if (harness !== undefined) await harness.close()
})
const numeric = z.coerce.number().nullable()

const FROM = "2005-06-10T00:00:00Z"
const TO = "2005-06-11T00:00:00Z"
const BEFORE = "2005-06-09T00:00:00Z"

describe("LOG-41 independent full-corpus SQL references", () => {
  it.each(["level", "component", "node"] as const)(
    "dictionary facet %s keeps original-table totals and null group",
    async (dimension) => {
      const oracle = await harness.sql(
        `SELECT ${dimension} AS key, count(*) AS events
          FROM log_events GROUP BY ${dimension}
      ORDER BY events DESC, key ASC NULLS LAST`,
        [],
        z.object({ key: z.string().nullable(), events: integer })
      )
      const actual = await harness.run(
        "count_events",
        { group_by: [dimension], top_n: 2 },
        countEventsOutputSchema
      )
      expect(
        actual.data.groups.map((row) => ({
          key: row[dimension],
          events: row.events,
        }))
      ).toEqual(oracle.slice(0, 2))
      expect(actual.data.total).toBe(
        oracle.reduce((sum, row) => sum + row.events, 0)
      )
      expect(actual.data.other?.events ?? 0).toBe(
        oracle.slice(2).reduce((sum, row) => sum + row.events, 0)
      )
    }
  )
  it("reconciles signed group contributions, including the truncated rest", async () => {
    const oracle = await harness.sql(
      `WITH periods AS (
        SELECT component, count(*) FILTER (WHERE ts >= $1::TIMESTAMPTZ AND ts < $2::TIMESTAMPTZ) AS c,
          count(*) FILTER (WHERE ts >= $3::TIMESTAMPTZ AND ts < $1::TIMESTAMPTZ) AS b
        FROM log_events WHERE dataset='bgl' AND ts >= $3::TIMESTAMPTZ AND ts < $2::TIMESTAMPTZ GROUP BY component
      ), changes AS (SELECT component,c,b,c-b AS delta FROM periods)
      SELECT component,c,b,delta, sum(delta) OVER() AS net,
        sum(greatest(delta,0)) OVER() AS positive, sum(least(delta,0)) OVER() AS negative,
        100.0 * delta / nullif(sum(delta) OVER(),0) AS contribution
      FROM changes ORDER BY abs(delta) DESC,c DESC,component ASC NULLS LAST`,
      [FROM, TO, BEFORE],
      z.object({
        component: z.string().nullable(),
        c: integer,
        b: integer,
        delta: integer,
        net: integer,
        positive: integer,
        negative: integer,
        contribution: numeric,
      })
    )
    const actual = await harness.run(
      "count_events",
      {
        dataset: "bgl",
        from: FROM,
        to: TO,
        group_by: ["component"],
        top_n: 1,
        compare: "previous_period",
        contributions: true,
      },
      countEventsOutputSchema
    )
    expect(actual.data.comparison?.decomposition).toEqual({
      positive_delta: oracle[0]?.positive ?? 0,
      negative_delta: oracle[0]?.negative ?? 0,
      net_delta: oracle[0]?.net ?? 0,
    })
    expectClose(
      actual.data.groups[0]?.contribution_to_delta ?? null,
      oracle[0]?.contribution ?? null
    )
    expectClose(
      actual.data.other?.contribution_to_delta ?? null,
      oracle.length <= 1 || oracle[0]?.net === 0
        ? null
        : oracle.slice(1).reduce((sum, row) => sum + (row.contribution ?? 0), 0)
    )
  })
  it("does not convert an unavailable reference into zero contribution", async () => {
    const actual = await harness.run(
      "count_events",
      {
        dataset: "bgl",
        from: FROM,
        to: TO,
        group_by: ["level"],
        compare: { from: "2004-01-01T00:00:00Z", to: "2004-01-02T00:00:00Z" },
        contributions: true,
      },
      countEventsOutputSchema
    )
    expect(actual.data.comparison?.determinable).toBe(false)
    expect(actual.data.comparison?.decomposition).toBeNull()
    expect(
      actual.data.groups.every((row) => row.contribution_to_delta === null)
    ).toBe(true)
  })
  it("matches periodic gap statistics independently derived from ordered raw timestamps", async () => {
    const candidates = await harness.sql(
      `SELECT pattern_id,count(*) AS n FROM log_events
      WHERE dataset='bgl' AND ts >= $1::TIMESTAMPTZ AND ts < $2::TIMESTAMPTZ GROUP BY pattern_id
      HAVING count(*) >= 4 ORDER BY n DESC,pattern_id LIMIT 1`,
      [FROM, TO],
      z.object({ pattern_id: z.string(), n: integer })
    )
    const pattern = candidates[0]
    if (pattern === undefined)
      throw new Error(
        "Golden fixture needs one observed pattern with four occurrences"
      )
    const oracle = await harness.sql(
      `WITH ordered AS (
      SELECT ts,lag(ts) OVER(ORDER BY ts,event_id) AS previous FROM log_events
      WHERE dataset='bgl' AND pattern_id=$3 AND ts >= $1::TIMESTAMPTZ AND ts < $2::TIMESTAMPTZ
    ), gaps AS (SELECT epoch(ts-previous) AS seconds FROM ordered WHERE previous IS NOT NULL)
    SELECT count(*) AS gaps,median(seconds) AS med,min(seconds) AS minimum,max(seconds) AS maximum,
      stddev_pop(seconds)/nullif(avg(seconds),0) AS cv FROM gaps`,
      [FROM, TO, pattern.pattern_id],
      z.object({
        gaps: integer,
        med: numeric,
        minimum: numeric,
        maximum: numeric,
        cv: numeric,
      })
    )
    const actual = await harness.run(
      "recurring_patterns",
      {
        dataset: "bgl",
        from: FROM,
        to: TO,
        analysis: { mode: "periodicity", pattern_id: pattern.pattern_id },
      },
      recurringPatternsOutputSchema
    )
    const analysis = actual.data.analysis
    if (analysis?.mode !== "periodicity")
      throw new Error("Missing periodicity result")
    expect(analysis.occurrences).toBe(pattern.n)
    expect(analysis.gaps).toBe(oracle[0]?.gaps)
    expectClose(analysis.median_gap_seconds, oracle[0]?.med ?? null)
    expectClose(analysis.min_gap_seconds, oracle[0]?.minimum ?? null)
    expectClose(analysis.max_gap_seconds, oracle[0]?.maximum ?? null)
    expectClose(analysis.coefficient_of_variation, oracle[0]?.cv ?? null)
  })
  it("uses the complete measured-duration population for outlier threshold and denominator", async () => {
    const oracle = await harness.sql(
      `WITH reference AS (
      SELECT quantile_cont(latency_ms,0.95) AS threshold,count(latency_ms) AS n
      FROM log_events WHERE dataset='openstack' AND http_status IS NOT NULL
    ) SELECT threshold,n,(SELECT count(*) FROM log_events,reference r WHERE dataset='openstack' AND http_status IS NOT NULL AND latency_ms>r.threshold) AS outliers FROM reference`,
      [],
      z.object({ threshold: numeric, n: integer, outliers: integer })
    )
    const actual = await harness.run(
      "latency_stats",
      { outliers: { threshold: "p95", min_baseline: 20 } },
      latencyStatsOutputSchema
    )
    expect(actual.data.outliers?.baseline_values).toBe(oracle[0]?.n)
    expect(actual.data.outliers?.outlier_events).toBe(oracle[0]?.outliers)
    expectClose(
      actual.data.outliers?.threshold_ms ?? null,
      oracle[0]?.threshold ?? null
    )
  })
  it("deduplicates raw/structured request entities against an independent complete SQL union", async () => {
    const oracle = await harness.sql(
      `WITH base AS (
        SELECT event_id,request_id,message FROM log_events WHERE dataset='openstack'
      ), entities AS (
        SELECT event_id,request_id AS entity FROM base WHERE request_id IS NOT NULL
        UNION SELECT event_id,unnest(regexp_extract_all(message,'req-[A-Za-z0-9-]+')) AS entity FROM base
      ), grouped AS (SELECT entity,count(*) AS events FROM entities GROUP BY entity)
      SELECT entity,events,(SELECT count(*) FROM base) AS total,
        (SELECT count(DISTINCT event_id) FROM entities) AS matched,
        (SELECT count(*) FROM entities) AS occurrences,
        count(*) OVER() AS distinct_entities
      FROM grouped ORDER BY events DESC,entity LIMIT 2`,
      [],
      z.object({
        entity: z.string(),
        events: integer,
        total: integer,
        matched: integer,
        occurrences: integer,
        distinct_entities: integer,
      })
    )
    const actual = await harness.run(
      "count_events",
      {
        dataset: "openstack",
        group_by: ["component"],
        entity: { type: "request_id" },
        top_n: 2,
      },
      countEventsOutputSchema
    )
    expect(actual.data.entity_distribution).toMatchObject({
      total_events: oracle[0]?.total,
      matched_events: oracle[0]?.matched,
      occurrences: oracle[0]?.occurrences,
      distinct_entities: oracle[0]?.distinct_entities,
    })
    expect(
      actual.data.entity_distribution?.groups.map(({ entity, events }) => ({
        entity,
        events,
      }))
    ).toEqual(oracle.map(({ entity, events }) => ({ entity, events })))
  })
  it("matches cooccurrence/order and control rates against a bounded raw timestamp join", async () => {
    const choices = await harness.sql(
      `SELECT pattern_id,count(*) AS n FROM log_events
      WHERE dataset='bgl' AND ts >= $1::TIMESTAMPTZ AND ts < $2::TIMESTAMPTZ
      GROUP BY pattern_id HAVING count(*) BETWEEN 2 AND 20 ORDER BY pattern_id LIMIT 3`,
      [FROM, TO],
      z.object({ pattern_id: z.string(), n: integer })
    )
    const [a, b, control] = choices
    if (a === undefined || b === undefined || control === undefined)
      throw new Error(
        "Golden reference needs three observed low-frequency patterns"
      )
    for (const direction of ["either", "after"] as const) {
      const condition =
        direction === "after"
          ? "b.ts>a.ts AND epoch(b.ts-a.ts)<=60"
          : "abs(epoch(b.ts-a.ts))<=60"
      const oracle = await harness.sql(
        `WITH raw AS MATERIALIZED (
        SELECT event_id,pattern_id,ts FROM log_events WHERE dataset='bgl' AND ts >= $1::TIMESTAMPTZ AND ts < $2::TIMESTAMPTZ AND pattern_id IN ($3,$4,$5)
      ) SELECT a.pattern_id,count(DISTINCT a.event_id) AS anchors,count(DISTINCT b.event_id*0+a.event_id) AS matched
        FROM raw a LEFT JOIN raw b ON b.pattern_id=$4 AND a.event_id<>b.event_id AND ${condition}
        WHERE a.pattern_id IN ($3,$5) GROUP BY a.pattern_id ORDER BY a.pattern_id`,
        [FROM, TO, a.pattern_id, b.pattern_id, control.pattern_id],
        z.object({ pattern_id: z.string(), anchors: integer, matched: integer })
      )
      const actual = await harness.run(
        "recurring_patterns",
        {
          dataset: "bgl",
          from: FROM,
          to: TO,
          analysis: {
            mode: "cooccurrence",
            pattern_a: a.pattern_id,
            pattern_b: b.pattern_id,
            control_pattern_id: control.pattern_id,
            direction,
            window_seconds: 60,
          },
        },
        recurringPatternsOutputSchema
      )
      const reference = oracle.find((row) => row.pattern_id === a.pattern_id)
      const controlReference = oracle.find(
        (row) => row.pattern_id === control.pattern_id
      )
      if (reference === undefined || controlReference === undefined)
        throw new Error("Missing oracle anchor groups")
      expect(actual.data.analysis).toMatchObject({
        mode: "cooccurrence",
        anchors: reference.anchors,
        matched_anchors: reference.matched,
        control_anchors: controlReference.anchors,
        control_matched_anchors: controlReference.matched,
      })
      if (actual.data.analysis?.mode !== "cooccurrence")
        throw new Error("Missing cooccurrence result")
      expectClose(
        actual.data.analysis.rate,
        reference.matched / reference.anchors
      )
      expectClose(
        actual.data.analysis.control_rate,
        controlReference.matched / controlReference.anchors
      )
    }
  })
})
