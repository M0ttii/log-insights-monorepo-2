/** Independent hand-authored LOG-41 cases: no expected value comes from tool code. */
import { rm } from "node:fs/promises"

import type { Fact } from "@workspace/domain/facts"
import { checkClaimsOutputSchema } from "@workspace/domain/tools/check-claims"
import { countEventsOutputSchema } from "@workspace/domain/tools/count-events"
import { recurringPatternsOutputSchema } from "@workspace/domain/tools/recurring-patterns"
import { latencyStatsOutputSchema } from "@workspace/domain/tools/latency-stats"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import {
  buildFixtureDatabase,
  fixtureConnection,
  type FixtureRow,
} from "./fixtures.ts"
import { loadEnv, temporaryDir } from "./helpers.ts"

loadEnv()
const DATABASE = "log_insights_log41_analytics"
const rows: FixtureRow[] = [
  {
    event_id: 1,
    dataset: "bgl",
    ts: "2005-06-30T00:00:00Z",
    level: "INFO",
    component: "SPAN",
    message: "start",
  },
  {
    event_id: 2,
    dataset: "bgl",
    ts: "2005-07-03T00:00:00Z",
    level: "INFO",
    component: "SPAN",
    message: "end",
  },
  ...[0, 60, 120, 180].map((seconds, index) => ({
    event_id: 10 + index,
    dataset: "bgl" as const,
    ts: new Date(
      Date.parse("2005-07-01T00:00:00Z") + seconds * 1000
    ).toISOString(),
    level: "FATAL",
    component: "KERNEL",
    pattern_id: "p_a",
    message: "scheduled alpha",
  })),
  ...[10, 70, 130, 190].map((seconds, index) => ({
    event_id: 20 + index,
    dataset: "bgl" as const,
    ts: new Date(
      Date.parse("2005-07-01T00:00:00Z") + seconds * 1000
    ).toISOString(),
    level: "FATAL",
    component: "KERNEL",
    pattern_id: "p_b",
    message: "scheduled beta",
  })),
  ...[300, 360].map((seconds, index) => ({
    event_id: 30 + index,
    dataset: "bgl" as const,
    ts: new Date(
      Date.parse("2005-07-01T00:00:00Z") + seconds * 1000
    ).toISOString(),
    level: "FATAL",
    component: "KERNEL",
    pattern_id: "p_control",
    message: "unrelated control",
  })),
  ...[0, 1, 2, 3, 4].map((index) => ({
    event_id: 10_000_001 + index,
    dataset: "openstack" as const,
    ts: `2017-05-14T10:0${index}:00Z`,
    level: "INFO",
    component: "nova-api",
    request_id: index === 4 ? "req-rare" : "req-common",
    message:
      index === 4
        ? "request req-rare from 10.0.0.9 /rare"
        : "request req-common req-common from 10.0.0.1 /common",
  })),
]
let db: Database
let registry: Registry
let directory: string
const call = () => ({
  client: "test" as const,
  signal: new AbortController().signal,
})
beforeAll(async () => {
  await buildFixtureDatabase(DATABASE, rows)
  db = createDatabase(fixtureConnection(DATABASE))
  await db.query(
    "CREATE OR REPLACE TABLE load_manifest AS SELECT 'dv_fixture000000000' AS data_version, 'concept-fixture' AS rules_version, '1.0.0' AS pattern_rules_version",
    [],
    call().signal
  )
  await db.query(
    "ALTER TABLE log_events ADD COLUMN http_status INTEGER",
    [],
    call().signal
  )
  await db.query(
    "ALTER TABLE log_events ADD COLUMN http_method VARCHAR",
    [],
    call().signal
  )
  await db.query(
    "ALTER TABLE log_events ADD COLUMN latency_ms DOUBLE",
    [],
    call().signal
  )
  await db.query(
    "UPDATE log_events SET http_status=200,http_method='GET',latency_ms=CASE WHEN event_id=10000005 THEN 1000 ELSE 100 END WHERE dataset='openstack'",
    [],
    call().signal
  )
  directory = await temporaryDir("log41-analytics-")
  registry = createRegistry({
    db,
    receipts: new FileReceiptStore(directory),
    log: () => undefined,
  })
})
afterAll(async () => {
  if (db !== undefined) await db.dispose()
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true })
})
async function run<T>(name: string, input: unknown, schema: z.ZodType<T>) {
  const outcome = await registry.runTool(name, input, call())
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
  return { ...outcome.result, data: schema.parse(outcome.result.data) }
}
async function verifyGroups(
  facts: readonly Fact[],
  path: string,
  value: number,
  group: Record<string, string>,
  wrongGroup: Record<string, string>
) {
  const fact = facts.find((candidate) => candidate.path === path)
  if (fact === undefined) throw new Error(`missing fact ${path}`)
  const checked = await run(
    "check_claims",
    {
      claims: [group, wrongGroup, {}].map((claimGroup) => ({
        fact: fact.id,
        value,
        metric: fact.metric,
        group: claimGroup,
      })),
    },
    checkClaimsOutputSchema
  )
  expect(checked.data.claims.map((claim) => claim.status)).toEqual([
    "verified",
    "mismatch",
    "mismatch",
  ])
  expect(checked.data.summary).toMatchObject({
    checked: 3,
    verified: 1,
    mismatch: 2,
    unresolved: 0,
  })
}
const window = {
  dataset: "bgl",
  from: "2005-07-01T00:00:00Z",
  to: "2005-07-02T00:00:00Z",
}

describe("LOG-41 independent analytical boundary cases", () => {
  it("counts common/rare entities once per event, including duplicate raw IDs and truncation", async () => {
    const all = await run(
      "count_events",
      {
        dataset: "openstack",
        group_by: ["component"],
        entity: { type: "request_id" },
        top_n: 1,
      },
      countEventsOutputSchema
    )
    expect(all.data.entity_distribution).toMatchObject({
      type: "request_id",
      total_events: 5,
      matched_events: 5,
      occurrences: 5,
      distinct_entities: 2,
      groups: [{ entity: "req-common", events: 4, share: 0.8 }],
      other: { entities: 1, events: 1, share: 0.2 },
      truncated: true,
    })
    await verifyGroups(
      all.facts,
      "/result/entity_distribution/groups/0/events",
      4,
      { type: "request_id", entity: "req-common" },
      { type: "ip", entity: "req-common" }
    )
    const rare = await run(
      "count_events",
      {
        dataset: "openstack",
        group_by: ["component"],
        entity: { type: "request_id", value: "req-rare" },
      },
      countEventsOutputSchema
    )
    expect(rare.data.entity_distribution).toMatchObject({
      total_events: 5,
      matched_events: 1,
      occurrences: 1,
      groups: [{ entity: "req-rare", events: 1, share: 0.2 }],
      other: null,
      truncated: false,
    })
    const absent = await run(
      "count_events",
      {
        dataset: "openstack",
        group_by: ["component"],
        entity: { type: "request_id", value: "req-absent" },
      },
      countEventsOutputSchema
    )
    expect(absent.data.entity_distribution).toMatchObject({
      matched_events: 0,
      occurrences: 0,
      distinct_entities: 0,
      groups: [],
      other: null,
    })
  })
  it("finds original IP/path entity values without replacing raw evidence", async () => {
    for (const [type, value] of [
      ["ip", "10.0.0.1"],
      ["path", "/common"],
    ]) {
      const actual = await run(
        "count_events",
        {
          dataset: "openstack",
          group_by: ["component"],
          entity: { type, value },
        },
        countEventsOutputSchema
      )
      expect(actual.data.entity_distribution).toMatchObject({
        matched_events: 4,
        groups: [{ entity: value, events: 4, share: 0.8 }],
      })
    }
  })
  it("distinguishes exact periodic gaps from insufficient observations", async () => {
    const actual = await run(
      "recurring_patterns",
      { ...window, analysis: { mode: "periodicity", pattern_id: "p_a" } },
      recurringPatternsOutputSchema
    )
    expect(actual.data.analysis).toMatchObject({
      mode: "periodicity",
      occurrences: 4,
      gaps: 3,
      minimum_occurrences: 4,
      median_gap_seconds: 60,
      min_gap_seconds: 60,
      max_gap_seconds: 60,
      coefficient_of_variation: 0,
      determinable: true,
    })
    await verifyGroups(
      actual.facts,
      "/result/analysis/median_gap_seconds",
      60,
      { pattern_id: "p_a" },
      { pattern_id: "p_b" }
    )
    const small = await run(
      "recurring_patterns",
      { ...window, analysis: { mode: "periodicity", pattern_id: "p_control" } },
      recurringPatternsOutputSchema
    )
    expect(small.data.analysis).toMatchObject({
      occurrences: 2,
      determinable: false,
    })
    const empty = await run(
      "recurring_patterns",
      { ...window, analysis: { mode: "periodicity", pattern_id: "absent" } },
      recurringPatternsOutputSchema
    )
    expect(empty.data.analysis).toMatchObject({
      occurrences: 0,
      determinable: false,
    })
  })
  it("reports temporal association with a discriminating control, never a cause", async () => {
    const actual = await run(
      "recurring_patterns",
      {
        ...window,
        analysis: {
          mode: "cooccurrence",
          pattern_a: "p_a",
          pattern_b: "p_b",
          window_seconds: 10,
          direction: "after",
          control_pattern_id: "p_control",
        },
      },
      recurringPatternsOutputSchema
    )
    expect(actual.data.analysis).toMatchObject({
      mode: "cooccurrence",
      anchors: 4,
      matched_anchors: 4,
      rate: 1,
      control_anchors: 2,
      control_matched_anchors: 0,
      control_rate: 0,
      rate_difference: 1,
    })
    expect(actual.data.analysis?.uncertainty).toMatch(/caus/i)
    await verifyGroups(
      actual.facts,
      "/result/analysis/rate",
      1,
      { pattern_a: "p_a", pattern_b: "p_b", direction: "after" },
      { pattern_a: "p_b", pattern_b: "p_a", direction: "after" }
    )
    await verifyGroups(
      actual.facts,
      "/result/analysis/control_rate",
      0,
      {
        pattern_a: "p_a",
        pattern_b: "p_b",
        direction: "after",
        control_pattern_id: "p_control",
      },
      {
        pattern_a: "p_a",
        pattern_b: "p_b",
        direction: "after",
        control_pattern_id: "p_wrong",
      }
    )
    const reverse = await run(
      "recurring_patterns",
      {
        ...window,
        analysis: {
          mode: "cooccurrence",
          pattern_a: "p_b",
          pattern_b: "p_a",
          window_seconds: 10,
          direction: "after",
        },
      },
      recurringPatternsOutputSchema
    )
    expect(reverse.data.analysis).toMatchObject({
      anchors: 4,
      matched_anchors: 0,
      rate: 0,
    })
  })
  it("keeps missing latency baselines unknown and validates an individual outlier case", async () => {
    const small = await run(
      "latency_stats",
      { outliers: { min_baseline: 20, case_event_id: 10000005 } },
      latencyStatsOutputSchema
    )
    expect(small.data.outliers).toMatchObject({
      baseline_values: 5,
      determinable: false,
      threshold_ms: null,
      outlier_events: null,
      rate: null,
      case_found: true,
      cases: [
        { event_id: 10000005, latency_ms: 1000, exceeds_threshold: null },
      ],
    })
    const measured = await run(
      "latency_stats",
      { outliers: { min_baseline: 5, case_event_id: 10000005 } },
      latencyStatsOutputSchema
    )
    expect(measured.data.outliers).toMatchObject({
      baseline_values: 5,
      determinable: true,
      outlier_events: 1,
      rate: 0.2,
      case_found: true,
      cases: [
        { event_id: 10000005, latency_ms: 1000, exceeds_threshold: true },
      ],
    })
    expect(measured.data.outliers?.threshold_ms).toBeCloseTo(820, 10)
    const filtered = await run(
      "latency_stats",
      {
        request_id: "req-common",
        outliers: { min_baseline: 4, case_event_id: 10000005 },
      },
      latencyStatsOutputSchema
    )
    expect(filtered.data.outliers).toMatchObject({
      baseline_values: 4,
      outlier_events: 0,
      case_found: false,
      cases: [],
    })
  })
})
