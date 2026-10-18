/**
 * count_events through the registry against SereneDB with the Loghub 2k
 * samples (`pnpm data:setup --samples`) and the synthetic counting
 * fixtures (count-fixtures.ts).
 *
 * Expected values were determined from the raw sample files, not from the
 * loader or the tool: a Python script split BGL_2k.log into its ten fields
 * (label, Unix seconds, date, node, text timestamp, node, type, component,
 * level, message; node `NULL` = no node) and OpenStack_2k.log into file
 * (service prefix = component), time, level, logger and the API access
 * suffix `"<method> <path> HTTP/1.1" status: <code> …`, then counted with
 * collections.Counter. Teams were assigned by hand from the ownership table
 * (corpus/sql/30_ownership.sql). Words were matched as lower-cased tokens
 * `[a-z0-9_]+([.:'][a-z0-9_]+)*`, as in search-logs.test.ts. BGL times are
 * the Unix seconds of the line plus the microseconds of its text timestamp,
 * in UTC.
 */
import { rm } from "node:fs/promises"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import { countEvents } from "../../src/tools/count-events.ts"
import {
  buildCountFixtures,
  COMPARE_BASELINE,
  COMPARE_CURRENT,
  countFixtureConnection,
} from "./count-fixtures.ts"
import { loadEnv, samplesConnection, temporaryDir } from "./helpers.ts"

loadEnv()

const BGL_FIRST = "2005-06-03T22:42:50.675872Z"
const BGL_END = "2006-01-03T15:13:09.127919Z"
const OPENSTACK_FIRST = "2017-05-16T00:00:00.008000Z"
const OPENSTACK_END = "2017-05-16T00:14:47.687001Z"
/** BGL lines 2 and 3; no other sample line lies between them. */
const LINE_2_TS = "2005-06-03T22:42:53.276129Z"
const LINE_3_TS = "2005-06-03T22:49:36.156884Z"

let db: Database
let fixturesDb: Database
let dir: string
let registry: Registry
let fixtures: Registry

beforeAll(async () => {
  await buildCountFixtures()
  db = createDatabase(samplesConnection())
  fixturesDb = createDatabase(countFixtureConnection())
  dir = await temporaryDir("analytics-count-")
  const receipts = new FileReceiptStore(dir)
  registry = createRegistry({ db, receipts, log: () => undefined })
  fixtures = createRegistry({
    db: fixturesDb,
    receipts,
    log: () => undefined,
  })
})

afterAll(async () => {
  await db.dispose()
  await fixturesDb.dispose()
  await rm(dir, { recursive: true, force: true })
})

const call = () => ({
  client: "test" as const,
  signal: new AbortController().signal,
})

async function count(input: Record<string, unknown>, on = registry) {
  const outcome = await on.runTool("count_events", input, call())
  if (!outcome.ok) throw new Error(outcome.error.message)
  return {
    ...outcome.result,
    data: countEvents.output.parse(outcome.result.data),
  }
}

/** Total of BGL in [from, to). */
async function window(from: string, to: string) {
  return (await count({ group_by: ["dataset"], dataset: "bgl", from, to })).data
    .total
}

/** The expected failure of a call, or null when it succeeds. */
async function error(input: Record<string, unknown>) {
  const outcome = await registry.runTool("count_events", input, call())
  return outcome.ok ? null : outcome.error
}

/** Groups as [values…, events] for compact comparison. */
async function groups(input: Record<string, unknown>, on = registry) {
  const { data } = await count(input, on)
  return data.groups.map((group) => [
    ...data.group_by.map((dimension) => group[dimension] ?? null),
    group.events,
  ])
}

describe("whole corpus", () => {
  it("counts every loaded line per dataset, over each full span (A-07)", async () => {
    const result = await count({ group_by: ["dataset"] })
    expect(result.data).toMatchObject({
      unit: "log_events",
      total: 4000,
      group_count: 2,
      groups: [
        { dataset: "bgl", events: 2000, share: 0.5 },
        { dataset: "openstack", events: 2000, share: 0.5 },
      ],
      other: null,
      truncated: false,
    })
    expect(result.receipt.scope).toEqual({
      windows: [
        { dataset: "bgl", from: BGL_FIRST, to: BGL_END },
        { dataset: "openstack", from: OPENSTACK_FIRST, to: OPENSTACK_END },
      ],
      filters: {},
    })
    expect(result.notes).toContain(
      "BGL (2005–2006) and OpenStack (2017) share no time axis: numbers across both datasets are totals over each dataset's window, not a comparison over the same time."
    )
  })

  it("counts per dataset and team from the ownership table (S-05)", async () => {
    // BGL: KERNEL 1820 (Compute Platform), APP 107 (Workload Runtime),
    // DISCOVERY 35 + HARDWARE 3 (Hardware Operations), MMCS 35 (Control
    // Plane). OpenStack: nova-api 1060 (API Gateway), nova-compute 933
    // (Compute Platform), nova-scheduler 7 (Control Plane).
    expect(await groups({ group_by: ["dataset", "team"] })).toEqual([
      ["bgl", "Compute Platform", 1820],
      ["openstack", "API Gateway", 1060],
      ["openstack", "Compute Platform", 933],
      ["bgl", "Workload Runtime", 107],
      ["bgl", "Hardware Operations", 38],
      ["bgl", "Control Plane", 35],
      ["openstack", "Control Plane", 7],
    ])
  })

  it("counts unowned components as their own team (S-05, fixtures)", async () => {
    // Fixture rows: 130 KERNEL (3 + 127 comparison rows) and 2 SERV_NET (no
    // ownership row) in BGL, 1 nova-api in OpenStack.
    const result = await count({ group_by: ["dataset", "team"] }, fixtures)
    expect(
      result.data.groups.map((g) => [g.dataset, g.team, g.events])
    ).toEqual([
      ["bgl", "Compute Platform", 130],
      ["bgl", "unowned", 2],
      ["openstack", "API Gateway", 1],
    ])
    expect(result.data.total).toBe(133)
    expect(
      result.facts.find((fact) => fact.path === "/result/groups/1/events")
    ).toMatchObject({
      value: 2,
      metric: "events",
      unit: "log_events",
      group: { dataset: "bgl", team: "unowned" },
    })
    expect(
      await groups({ group_by: ["component"], teams: ["unowned"] }, fixtures)
    ).toEqual([["SERV_NET", 2]])
  })
})

describe("groups and other", () => {
  it("sums the groups beyond top_n in other; shares and other add up to 1", async () => {
    // Components: KERNEL 1820, nova-api 1060, nova-compute 933, APP 107,
    // DISCOVERY 35, MMCS 35, nova-scheduler 7, HARDWARE 3.
    const result = await count({ group_by: ["component"], top_n: 3 })
    expect(result.data).toMatchObject({
      total: 4000,
      group_count: 8,
      groups: [
        { component: "KERNEL", events: 1820, share: 0.455 },
        { component: "nova-api", events: 1060, share: 0.265 },
        { component: "nova-compute", events: 933, share: 0.23325 },
      ],
      other: { groups: 5, events: 187, share: 0.04675 },
      truncated: true,
      top_n: 3,
    })
    // Shares are unrounded doubles; their sum is 1 up to floating-point error.
    const shares = result.data.groups.reduce(
      (sum, g) => sum + (g.share ?? 0),
      0
    )
    expect(shares + (result.data.other?.share ?? 0)).toBeCloseTo(1, 12)
    expect(result.receipt).toMatchObject({
      rows_returned: 3,
      truncated: true,
      population: { count: 4000, unit: "log_events" },
    })
    expect(
      result.facts
        .filter((fact) => fact.path.startsWith("/result/other"))
        .map((fact) => [fact.metric, fact.value])
    ).toEqual([
      ["other_events", 187],
      ["other_groups", 5],
      ["other_share", 0.04675],
    ])
  })

  it("breaks ties by the dimension value", async () => {
    // DISCOVERY and MMCS both have 35 events.
    const { data } = await count({ group_by: ["component"], top_n: 5 })
    expect(data.groups.at(-1)).toMatchObject({
      component: "DISCOVERY",
      events: 35,
    })
    expect(data.other).toEqual({ groups: 3, events: 45, share: 0.01125 })
  })

  it("keeps missing values as category null across two dimensions", async () => {
    // OpenStack lines have no node; 35 BGL lines carry node NULL. BGL has
    // 1777 distinct nodes plus null, OpenStack only null.
    const result = await count({ group_by: ["dataset", "node"], top_n: 4 })
    expect(
      result.data.groups.map((g) => [g.dataset, g.node, g.events])
    ).toEqual([
      ["openstack", null, 2000],
      ["bgl", "R30-M0-N9-C:J16-U01", 60],
      ["bgl", null, 35],
      ["bgl", "R02-M1-N0-C:J12-U11", 30],
    ])
    expect(result.data).toMatchObject({
      group_count: 1779,
      other: { groups: 1775, events: 1875 },
    })
    expect(
      result.facts.find((fact) => fact.path === "/result/groups/0/events")
        ?.group
    ).toEqual({ dataset: "openstack" })
  })
})

describe("filters", () => {
  it("counts error events after R-02 per component", async () => {
    // BGL errors (ERROR, SEVERE, FATAL, FAILURE): 395; OpenStack has none
    // (INFO 1969, WARNING 31).
    expect(
      await groups({ group_by: ["component"], only_errors: true })
    ).toEqual([
      ["KERNEL", 240],
      ["APP", 107],
      ["MMCS", 35],
      ["DISCOVERY", 12],
      ["HARDWARE", 1],
    ])
  })

  it("filters by levels and by a window", async () => {
    expect(
      await groups({ group_by: ["level"], levels: ["FATAL", "ERROR"] })
    ).toEqual([
      ["FATAL", 347],
      ["ERROR", 41],
    ])
    expect(
      await groups({
        group_by: ["level"],
        dataset: "bgl",
        from: "2005-06-01T00:00:00Z",
        to: "2005-07-01T00:00:00Z",
      })
    ).toEqual([
      ["INFO", 283],
      ["FATAL", 213],
      ["WARNING", 1],
    ])
  })

  it("applies text with all words required", async () => {
    // cache: 51 KERNEL lines, cache and parity: 48 (all INFO), error: 238.
    expect(await groups({ group_by: ["component"], text: "cache" })).toEqual([
      ["KERNEL", 51],
    ])
    expect(await groups({ group_by: ["level"], text: "cache parity" })).toEqual(
      [["INFO", 48]]
    )
    expect(await groups({ group_by: ["component"], text: "error" })).toEqual([
      ["KERNEL", 146],
      ["APP", 86],
      ["DISCOVERY", 6],
    ])
  })

  it("includes an event exactly on from and excludes one exactly on to", async () => {
    expect(await window(LINE_2_TS, LINE_3_TS)).toBe(1)
    // One microsecond later: line 2 is out, line 3 is in.
    expect(
      await window("2005-06-03T22:42:53.276130Z", "2005-06-03T22:49:36.156885Z")
    ).toBe(1)
    expect(
      await window("2005-06-03T22:42:53.276130Z", "2005-06-03T22:49:36.156884Z")
    ).toBe(0)
    // The same instant with an offset.
    expect(await window("2005-06-03T15:42:53.276129-07:00", LINE_3_TS)).toBe(1)
  })

  it("names a window outside the data span instead of reporting an observed zero", async () => {
    const result = await count({
      group_by: ["component"],
      dataset: "openstack",
      from: "2018-01-01T00:00:00Z",
      to: "2018-02-01T00:00:00Z",
    })
    expect(result.data).toMatchObject({ total: 0, groups: [], other: null })
    expect(result.notes).toContain(
      "The openstack window lies outside its data span (2017-05-16T00:00:00.008000Z to 2017-05-16T00:14:47.687000Z): its count of 0 is not an observed zero (R-03)."
    )
  })
})

describe("API accesses", () => {
  it("counts lines with an HTTP status as api_accesses (R-01)", async () => {
    // 1017 access lines, all nova-api: 200 933, 404 41, 204 22, 202 21.
    const result = await count({ group_by: ["http_status"] })
    expect(result.data).toMatchObject({ unit: "api_accesses", total: 1017 })
    expect(result.data.groups.map((g) => [g.http_status, g.events])).toEqual([
      [200, 933],
      [404, 41],
      [204, 22],
      [202, 21],
    ])
    expect(result.receipt.population).toEqual({
      count: 1017,
      unit: "api_accesses",
    })
    expect(result.receipt.scope.windows).toEqual([
      { dataset: "openstack", from: OPENSTACK_FIRST, to: OPENSTACK_END },
    ])
    expect(result.facts.find((f) => f.path === "/result/total")).toMatchObject({
      metric: "api_accesses",
      unit: "api_accesses",
      value: 1017,
    })
  })

  it("groups by endpoint with IDs masked", async () => {
    const { data } = await count({ group_by: ["endpoint"], top_n: 2 })
    expect(data).toMatchObject({
      total: 1017,
      group_count: 25,
      groups: [
        { endpoint: "/v2/<ID>/servers/detail", events: 700 },
        { endpoint: "/openstack/2013-10-17/vendor_data.json", events: 44 },
      ],
      other: { groups: 23, events: 273 },
    })
  })

  it("rejects BGL-only dimensions with API dimensions", async () => {
    const outcome = await registry.runTool(
      "count_events",
      { group_by: ["endpoint", "rack"] },
      call()
    )
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "group_by" }],
    })
  })
})

describe("compare", () => {
  const august = {
    group_by: ["component"],
    dataset: "bgl",
    from: "2005-08-01T00:00:00Z",
    to: "2005-09-01T00:00:00Z",
    compare: "previous_period",
  }

  it("compares a month with the previous one per component (A-09)", async () => {
    // August 2005 (C) against July 2005 (B, 31 days as well): KERNEL 123 /
    // 696, APP 22 / 3, DISCOVERY 21 / 3, MMCS 9 / 0, HARDWARE 2 / 0.
    const result = await count(august)
    expect(
      result.data.groups.map((g) => [
        g.component,
        g.events,
        g.baseline,
        g.delta,
        g.classification,
      ])
    ).toEqual([
      ["KERNEL", 123, 696, -573, null],
      // +19: more than doubled, but fewer than 20 additional events.
      ["APP", 22, 3, 19, null],
      ["DISCOVERY", 21, 3, 18, null],
      ["MMCS", 9, 0, 9, "first observed in this comparison"],
      ["HARDWARE", 2, 0, 2, "first observed in this comparison"],
    ])
    expect(result.data.groups[0]?.pct_change).toBeCloseTo(
      (100 * -573) / 696,
      12
    )
    expect(result.data.groups[1]?.pct_change).toBeCloseTo((100 * 19) / 3, 12)
    expect(result.data.groups[3]?.pct_change).toBeNull()
    expect(result.data).toMatchObject({
      total: 177,
      group_count: 5,
      comparison: {
        reference: "previous_period",
        coverage: { current: "full", baseline: "full" },
        determinable: true,
        baseline: 702,
        delta: -525,
        classification: null,
      },
    })
    expect(result.data.comparison?.pct_change).toBeCloseTo(
      (100 * -525) / 702,
      12
    )
    expect(result.receipt.scope.windows).toEqual([
      {
        dataset: "bgl",
        from: "2005-08-01T00:00:00Z",
        to: "2005-09-01T00:00:00Z",
        period: "current",
      },
      {
        dataset: "bgl",
        from: "2005-07-01T00:00:00.000000Z",
        to: "2005-08-01T00:00:00.000000Z",
        period: "baseline",
      },
    ])
  })

  it("classifies a significant increase of error events", async () => {
    // BGL error events: August 45, July 8 (+37, more than doubled).
    const result = await count({
      ...august,
      group_by: ["dataset"],
      only_errors: true,
    })
    expect(result.data.comparison).toMatchObject({
      baseline: 8,
      delta: 37,
      classification: "significantly increased",
    })
    expect(result.data.groups[0]).toMatchObject({
      dataset: "bgl",
      events: 45,
      baseline: 8,
      classification: "significantly increased",
    })
  })

  it("applies the R-06 boundaries exactly (fixtures)", async () => {
    const result = await count(
      {
        group_by: ["level"],
        dataset: "bgl",
        ...COMPARE_CURRENT,
        compare: COMPARE_BASELINE,
      },
      fixtures
    )
    expect(
      result.data.groups.map((g) => [
        g.level,
        g.events,
        g.baseline,
        g.delta,
        g.pct_change,
        g.classification,
      ])
    ).toEqual([
      ["FATAL", 40, 20, 20, 100, "significantly increased"],
      ["ERROR", 38, 19, 19, 100, null],
      ["FAILURE", 0, 5, -5, -100, null],
      ["SEVERE", 3, 0, 3, null, "first observed in this comparison"],
    ])
    // Events exactly at the end of C and 1 µs before B are in neither period.
    expect(result.data).toMatchObject({
      total: 81,
      comparison: { reference: "custom", baseline: 44, delta: 37 },
    })
    const fact = result.facts.find(
      (candidate) => candidate.path === "/result/groups/2/baseline"
    )
    expect(fact).toMatchObject({
      value: 5,
      metric: "events_baseline",
      unit: "log_events",
      group: { level: "FAILURE" },
    })
  })

  it("labels a scope without events in either period", async () => {
    const result = await count(
      {
        group_by: ["level"],
        dataset: "bgl",
        ...COMPARE_CURRENT,
        compare: "previous_period",
        levels: ["WARNING"],
      },
      fixtures
    )
    expect(result.data).toMatchObject({
      total: 0,
      groups: [],
      comparison: {
        determinable: true,
        baseline: 0,
        delta: 0,
        pct_change: null,
        classification: "not observed in either period",
      },
    })
  })

  it("marks a baseline outside the data span as not determinable (§ 13)", async () => {
    // OpenStack sample: 2017-05-16T00:00:00.008 to 00:14:47.687. The
    // previous 10 minutes lie before the first event.
    const result = await count({
      group_by: ["level"],
      dataset: "openstack",
      from: "2017-05-16T00:00:00Z",
      to: "2017-05-16T00:10:00Z",
      compare: "previous_period",
    })
    expect(result.data.comparison).toEqual({
      reference: "previous_period",
      coverage: { current: "partial", baseline: "none" },
      determinable: false,
      baseline: null,
      delta: null,
      pct_change: null,
      classification: null,
    })
    for (const group of result.data.groups)
      expect(group).toMatchObject({
        baseline: null,
        delta: null,
        pct_change: null,
        classification: null,
      })
    expect(
      result.facts.filter((fact) => fact.metric === "events_baseline")
    ).toEqual([])
    expect(result.notes).toContain(
      "The comparison is not determinable: the baseline lies outside the openstack data span (2017-05-16T00:00:00.008000Z to 2017-05-16T00:14:47.687000Z). B, delta, pct_change and classification are null: no data is not an observed zero (R-03)."
    )
  })

  it("marks a baseline partly outside the data span as partial", async () => {
    // July 2005 against [2005-05-31, 2005-07-01); BGL samples start on
    // 2005-06-03. KERNEL 696 / 487, APP 3 / 9, DISCOVERY 3 / 1.
    const result = await count({
      ...august,
      from: "2005-07-01T00:00:00Z",
      to: "2005-08-01T00:00:00Z",
    })
    expect(result.data.comparison).toMatchObject({
      coverage: { current: "full", baseline: "partial" },
      determinable: true,
      baseline: 497,
      delta: 205,
    })
    expect(
      result.data.groups.map((g) => [g.component, g.events, g.baseline])
    ).toEqual([
      ["KERNEL", 696, 487],
      ["APP", 3, 9],
      ["DISCOVERY", 3, 1],
    ])
    expect(result.notes).toContain(
      `The baseline is only partly covered by data (bgl data span ${BGL_FIRST} to 2006-01-03T15:13:09.127918Z): B counts only the observed part, so the change is limited and may overstate an increase.`
    )
  })

  it("rejects unequal references, two dimensions and two datasets", async () => {
    expect(
      await error({
        ...august,
        compare: { from: "2005-07-01T00:00:00Z", to: "2005-07-31T00:00:00Z" },
      })
    ).toMatchObject({
      code: "invalid_input",
      issues: [
        {
          path: "compare",
          message:
            "The reference must be as long as [from, to) (R-06): 31 d expected, 30 d given.",
        },
      ],
    })
    expect(
      await error({ ...august, group_by: ["component", "level"] })
    ).toMatchObject({ issues: [{ path: "group_by" }] })
    const { dataset: _dataset, ...withoutDataset } = august
    expect(await error(withoutDataset)).toMatchObject({
      issues: [
        {
          path: "dataset",
          message:
            "compare needs exactly one dataset: comparisons run within one dataset; BGL and OpenStack share no time axis.",
        },
      ],
    })
  })

  it("is reproducible: same digest on a second run and on rerun", async () => {
    const first = await count(august)
    const second = await count(august)
    expect(second.receipt.result_digest).toBe(first.receipt.result_digest)
    const rerun = await registry.rerun(first.receipt.receipt_id, call())
    expect(rerun.ok ? rerun.matches : rerun.error).toEqual({
      signature: true,
      data_version: true,
      result_digest: true,
    })
  })
})

describe("receipt", () => {
  it("stores every SQL text, the population and the facts", async () => {
    const result = await count({
      group_by: ["dataset", "team"],
      only_errors: true,
      top_n: 2,
    })
    const stored = await new FileReceiptStore(dir).get(
      result.receipt.receipt_id
    )
    if (stored === null) throw new Error("receipt missing")
    expect(stored.input).toEqual({
      group_by: ["dataset", "team"],
      only_errors: true,
      top_n: 2,
    })
    expect(stored.sql).toHaveLength(3)
    expect(stored.sql[0]).toContain("FROM corpus_stats")
    expect(stored.sql[1]).toContain("FROM corpus_stats")
    expect(stored.sql[2]).toMatch(/^WITH grouped AS/)
    expect(stored.params).toEqual([["bgl"], ["openstack"], [2, 2, 20]])
    // BGL errors: Compute Platform 240, Workload Runtime 107, Control Plane 35, Hardware Operations 13.
    expect(stored.population).toEqual({ count: 395, unit: "log_events" })
    expect(stored.scope.filters).toEqual({ only_errors: true })
    expect(stored.result).toMatchObject({
      groups: [
        { dataset: "bgl", team: "Compute Platform", events: 240 },
        { dataset: "bgl", team: "Workload Runtime", events: 107 },
      ],
      other: { groups: 2, events: 48 },
    })
    expect(stored.facts.map((fact) => fact.metric)).toEqual([
      "groups",
      "events",
      "share",
      "events",
      "share",
      "other_events",
      "other_groups",
      "other_share",
      "events",
      "window_start",
      "window_end",
      "window_start",
      "window_end",
    ])
  })

  it("is reproducible: same digest on a second run and on rerun", async () => {
    for (const input of [
      { group_by: ["dataset", "node"], top_n: 10 },
      { group_by: ["component"], text: "error" },
      { group_by: ["http_status", "endpoint"] },
    ]) {
      const first = await count(input)
      const second = await count(input)
      expect(second.receipt.signature).toBe(first.receipt.signature)
      expect(second.receipt.result_digest).toBe(first.receipt.result_digest)
      const rerun = await registry.rerun(first.receipt.receipt_id, call())
      expect(rerun.ok ? rerun.matches : rerun.error).toEqual({
        signature: true,
        data_version: true,
        result_digest: true,
      })
    }
  })
})
