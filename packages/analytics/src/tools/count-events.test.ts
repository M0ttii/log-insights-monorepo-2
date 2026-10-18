import type { Receipt } from "@workspace/domain/receipt"
import { comparisonCoverage } from "@workspace/domain/rules/compare"
import { describe, expect, it } from "vitest"

import { createRegistry } from "../registry.ts"
import { countEvents } from "./count-events.ts"

/**
 * count_events against a fake database: the SQL it sends, the cross-field
 * rules, the facts that follow group_by and the notes. Behaviour against
 * SereneDB is covered by tests/integration/count-events.test.ts.
 */

const SPAN = {
  bgl: {
    first: "2005-06-03T22:42:50.675872Z",
    last: "2006-01-03T15:13:09.127918Z",
  },
  openstack: {
    first: "2017-05-16T00:00:00.008000Z",
    last: "2017-05-16T00:14:47.687000Z",
  },
}

type Row = Record<string, unknown>

const NO_CHANGE = {
  baseline: null,
  delta: null,
  pct_change: null,
  classification: null,
}
const NO_OTHER_CHANGE = {
  other_baseline: null,
  other_delta: null,
  other_pct_change: null,
}
const GROUP_ONLY = {
  group_count: null,
  other_groups: null,
  other_events: null,
  other_share: null,
  ...NO_OTHER_CHANGE,
}

const SUMMARY: Row = {
  rank: "0",
  g1: null,
  g2: null,
  events: "10",
  share: null,
  ...NO_CHANGE,
  group_count: "3",
  other_groups: "1",
  other_events: "2",
  other_share: 0.2,
  ...NO_OTHER_CHANGE,
}

const GROUPS: Row[] = [
  {
    rank: "1",
    g1: "bgl",
    g2: "Compute Platform",
    events: "5",
    share: 0.5,
    ...NO_CHANGE,
    ...GROUP_ONLY,
  },
  {
    rank: "2",
    g1: "openstack",
    g2: "unowned",
    events: "3",
    share: 0.3,
    ...NO_CHANGE,
    ...GROUP_ONLY,
  },
]

type Call = { sql: string; params: readonly unknown[] }

function setup(rows: Row[] = [SUMMARY, ...GROUPS]) {
  const calls: Call[] = []
  const stored: Receipt[] = []
  const db = {
    timeoutMs: 10_000,
    async query(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params })
      const answer = ((): Row[] => {
        if (sql === "SELECT data_version FROM load_manifest")
          return [{ data_version: "dv_test" }]
        if (sql === "SELECT dataset FROM corpus_stats ORDER BY dataset")
          return [{ dataset: "bgl" }, { dataset: "openstack" }]
        if (sql.includes("FROM corpus_stats")) {
          const dataset = params[0] === "openstack" ? "openstack" : "bgl"
          return [SPAN[dataset]]
        }
        if (sql.startsWith("WITH comparison_bounds"))
          return [
            comparisonCoverage(
              { from: String(params[0]), to: String(params[1]) },
              { from: String(params[2]), to: String(params[3]) },
              { first: String(params[4]), last: String(params[5]) }
            ),
          ]
        if (sql.startsWith("WITH grouped")) return rows
        throw new Error(`unexpected SQL: ${sql}`)
      })()
      return { rows: answer, durationMs: 1 }
    },
  }
  const registry = createRegistry({
    db,
    receipts: {
      put: async (receipt) => {
        stored.push(receipt)
      },
      get: async () => null,
      list: async () => [],
    },
    log: () => undefined,
  })
  const count = (input: unknown) =>
    registry.runTool("count_events", input, {
      client: "test",
      signal: new AbortController().signal,
    })
  const summarize = (
    result: Parameters<(typeof registry.tools)[number]["summarize"]>[0]
  ) =>
    registry.tools
      .find((tool) => tool.name === "count_events")
      ?.summarize(result)
  return { calls, stored, count, summarize }
}

const toolCalls = (calls: Call[]) =>
  calls.filter((call) => !call.sql.includes("load_manifest"))

const TEAM =
  "coalesce((SELECT o.team FROM ownership o WHERE o.dataset = log_events.dataset AND o.component = log_events.component), 'unowned')"

describe("count_events SQL", () => {
  it("ranks the groups and returns total and other from the same statement", async () => {
    const { calls, count } = setup()
    const outcome = await count({
      group_by: ["dataset", "team"],
      only_errors: true,
      top_n: 2,
    })
    expect(outcome.ok).toBe(true)
    const spans = toolCalls(calls).filter((call) =>
      call.sql.includes("corpus_stats WHERE dataset = $1")
    )
    expect(spans.map((call) => call.params)).toEqual([["bgl"], ["openstack"]])
    const counted = toolCalls(calls).at(-1)
    expect(counted?.sql).toContain(
      `WITH grouped AS (SELECT log_events.dataset AS g1, ${TEAM} AS g2, count(*) AS events, NULL::BIGINT AS baseline FROM log_events WHERE log_events.is_error GROUP BY 1, 2)`
    )
    expect(counted?.sql).toContain(
      "ORDER BY events DESC, g1 ASC NULLS LAST, g2 ASC NULLS LAST"
    )
    expect(counted?.sql).toContain(
      "other_c::DOUBLE / NULLIF(c, 0) AS other_share"
    )
    expect(counted?.sql).toContain("WHERE rank <= $1 ORDER BY rank")
    expect(counted?.sql).toContain("$2::BIGINT * baseline")
    expect(counted?.sql).toContain("events - baseline >= $3::BIGINT")
    expect(counted?.params).toEqual([2, 2, 20])
  })

  it("reads the index relation for text and binds the filters before top_n", async () => {
    const { calls, count } = setup()
    await count({
      group_by: ["level"],
      dataset: "bgl",
      from: "2005-06-01T00:00:00Z",
      to: "2005-07-01T00:00:00Z",
      text: "cache parity",
    })
    const counted = toolCalls(calls).at(-1)
    expect(counted?.sql).toContain(
      "SELECT log_events_idx.level AS g1, count(*) AS events, NULL::BIGINT AS baseline FROM log_events_idx WHERE log_events_idx.dataset = $1 AND log_events_idx.ts >= $2::TIMESTAMPTZ AND log_events_idx.ts < $3::TIMESTAMPTZ AND log_events_idx.message @@ plainto_tsquery($4) GROUP BY 1)"
    )
    expect(counted?.sql).toContain("WHERE rank <= $5 ORDER BY rank")
    expect(counted?.params).toEqual([
      "bgl",
      "2005-06-01T00:00:00Z",
      "2005-07-01T00:00:00Z",
      "cache parity",
      20,
      2,
      20,
    ])
  })

  it("counts API accesses for http_status and endpoint, with only the OpenStack window", async () => {
    const { calls, stored, count } = setup([
      { ...SUMMARY, other_groups: "0", other_events: "0", other_share: 0 },
    ])
    const outcome = await count({ group_by: ["http_status", "component"] })
    expect(outcome.ok).toBe(true)
    const spans = toolCalls(calls).filter((call) =>
      call.sql.includes("corpus_stats")
    )
    expect(spans.map((call) => call.params)).toEqual([["openstack"]])
    expect(toolCalls(calls).at(-1)?.sql).toContain(
      "SELECT log_events.http_status AS g1, log_events.component AS g2, count(*) AS events, NULL::BIGINT AS baseline FROM log_events WHERE log_events.dataset = 'openstack' AND log_events.http_status IS NOT NULL GROUP BY 1, 2"
    )
    expect(stored[0]?.population).toEqual({ count: 10, unit: "api_accesses" })
    expect(outcome.ok && outcome.result.data).toMatchObject({
      unit: "api_accesses",
      other: null,
      truncated: false,
    })
  })
})

async function issues(input: Record<string, unknown>) {
  const { calls, count } = setup()
  const outcome = await count(input)
  expect(toolCalls(calls)).toEqual([])
  return outcome.ok ? null : outcome.error
}

describe("count_events validation", () => {
  it("needs one or two distinct dimensions", async () => {
    expect(await issues({ group_by: [] })).toMatchObject({
      code: "invalid_input",
    })
    expect(
      await issues({ group_by: ["dataset", "team", "level"] })
    ).toMatchObject({ code: "invalid_input" })
    expect(await issues({ group_by: ["team", "team"] })).toMatchObject({
      code: "invalid_input",
      issues: [
        {
          path: "group_by",
          message: "team is listed twice; dimensions must be distinct.",
        },
      ],
    })
    expect(await issues({ group_by: ["message"] })).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "group_by[0]" }],
    })
  })

  it("bounds top_n to 1–50", async () => {
    expect(await issues({ group_by: ["level"], top_n: 0 })).toMatchObject({
      code: "invalid_input",
    })
    expect(await issues({ group_by: ["level"], top_n: 51 })).toMatchObject({
      code: "invalid_input",
    })
  })

  it("keeps API accesses apart from BGL dimensions, filters and dataset", async () => {
    expect(
      await issues({
        group_by: ["http_status", "node"],
        dataset: "bgl",
        only_alerts: true,
      })
    ).toMatchObject({
      code: "invalid_input",
      hint: "http_status and endpoint count OpenStack API accesses: group or filter by fields of other datasets in a separate call.",
      issues: [
        {
          path: "group_by",
          message:
            "node is bgl-only; http_status counts OpenStack API accesses.",
        },
        {
          path: "dataset",
          message:
            "http_status counts OpenStack API accesses; use dataset openstack or leave it out.",
        },
        {
          path: "only_alerts",
          message: "bgl-only; http_status counts OpenStack API accesses.",
        },
      ],
    })
  })

  it("applies the shared filter rules", async () => {
    expect(
      await issues({
        group_by: ["level"],
        dataset: "openstack",
        node: "R02",
        from: "2017-05-17T00:00:00Z",
        to: "2017-05-16T00:00:00Z",
      })
    ).toMatchObject({
      code: "invalid_input",
      issues: [
        { path: "to" },
        { path: "node", message: "Only available for dataset bgl." },
      ],
    })
  })
})

describe("count_events result", () => {
  it("maps the groups, other and facts keyed by group_by", async () => {
    const { stored, count, summarize } = setup()
    const outcome = await count({
      group_by: ["dataset", "team"],
      top_n: 2,
    })
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(outcome.result.data).toEqual({
      group_by: ["dataset", "team"],
      unit: "log_events",
      total: 10,
      group_count: 3,
      groups: [
        { dataset: "bgl", team: "Compute Platform", events: 5, share: 0.5 },
        { dataset: "openstack", team: "unowned", events: 3, share: 0.3 },
      ],
      other: { groups: 1, events: 2, share: 0.2 },
      comparison: null,
      truncated: true,
      top_n: 2,
    })
    expect(stored[0]).toMatchObject({
      population: { count: 10, unit: "log_events" },
      rows_returned: 2,
      truncated: true,
      row_limit: 2,
      input: { group_by: ["dataset", "team"], top_n: 2 },
    })
    const id = outcome.result.receipt.receipt_id
    expect(
      outcome.result.facts.map(({ id: factId, path, ...fact }) => [
        factId.slice(id.length),
        path,
        fact,
      ])
    ).toEqual([
      [
        ".f1",
        "/result/group_count",
        { value: 3, metric: "groups", unit: "groups", group: {} },
      ],
      [
        ".f2",
        "/result/groups/0/events",
        {
          value: 5,
          metric: "events",
          unit: "log_events",
          group: { dataset: "bgl", team: "Compute Platform" },
        },
      ],
      [
        ".f3",
        "/result/groups/0/share",
        {
          value: 0.5,
          metric: "share",
          unit: "ratio",
          group: { dataset: "bgl", team: "Compute Platform" },
        },
      ],
      [".f4", "/result/groups/1/events", expect.objectContaining({ value: 3 })],
      [
        ".f5",
        "/result/groups/1/share",
        expect.objectContaining({ value: 0.3 }),
      ],
      [
        ".f6",
        "/result/other/events",
        { value: 2, metric: "other_events", unit: "log_events", group: {} },
      ],
      [
        ".f7",
        "/result/other/groups",
        { value: 1, metric: "other_groups", unit: "groups", group: {} },
      ],
      [
        ".f8",
        "/result/other/share",
        { value: 0.2, metric: "other_share", unit: "ratio", group: {} },
      ],
      [
        ".f9",
        "/result/total",
        { value: 10, metric: "events", unit: "log_events", group: {} },
      ],
      [
        ".f10",
        "/scope/windows/0/from",
        expect.objectContaining({ group: { dataset: "bgl" } }),
      ],
      [
        ".f11",
        "/scope/windows/0/to",
        expect.objectContaining({ value: "2006-01-03T15:13:09.127919Z" }),
      ],
      [
        ".f12",
        "/scope/windows/1/from",
        expect.objectContaining({ group: { dataset: "openstack" } }),
      ],
      [
        ".f13",
        "/scope/windows/1/to",
        expect.objectContaining({ value: "2017-05-16T00:14:47.687001Z" }),
      ],
    ])
    expect(outcome.result.notes).toEqual([
      "Counts are log events (parsed lines), not incidents or outages.",
      "BGL (2005–2006) and OpenStack (2017) share no time axis: numbers across both datasets are totals over each dataset's window, not a comparison over the same time.",
      "Truncated: 2 of 3 groups listed; the other 1 are summed in other. Raise top_n (max 50) or narrow the filters to list them.",
      "Teams come from a fictional ownership table (Serene Platform); unmapped components are 'unowned'.",
    ])
    expect(summarize(outcome.result)?.split("\n")).toEqual([
      `count_events by dataset, team · receipt ${id}`,
      "Scope: bgl [2005-06-03T22:42:50.675872Z, 2006-01-03T15:13:09.127919Z), openstack [2017-05-16T00:00:00.008000Z, 2017-05-16T00:14:47.687001Z).",
      `10 log events in scope [${id}.f9] in 3 groups [${id}.f1]; 2 shown, truncated: true.`,
      `1. dataset="bgl", team="Compute Platform": 5 [${id}.f2] (50 % [${id}.f3])`,
      `2. dataset="openstack", team="unowned": 3 [${id}.f4] (30 % [${id}.f5])`,
      `other: 1 groups [${id}.f7], 2 [${id}.f6] (20 % [${id}.f8])`,
      ...outcome.result.notes.map((note) => `Note: ${note}`),
    ])
  })

  it("keeps null as its own category and leaves it out of the fact group", async () => {
    const { count } = setup([
      {
        ...SUMMARY,
        events: "4",
        group_count: "1",
        other_groups: "0",
        other_events: "0",
        other_share: 0,
      },
      { ...GROUPS[0], g1: "openstack", g2: null, events: "4", share: 1 },
    ])
    const outcome = await count({ group_by: ["dataset", "node"] })
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(countEvents.output.parse(outcome.result.data).groups).toEqual([
      { dataset: "openstack", node: null, events: 4, share: 1 },
    ])
    expect(
      outcome.result.facts.find(
        (fact) => fact.path === "/result/groups/0/events"
      )?.group
    ).toEqual({ dataset: "openstack" })
    expect(outcome.result.notes).toContain(
      "null is its own category: these events have no value for that dimension (e.g. node for OpenStack or BGL service-node lines)."
    )
  })

  it("names an empty scope and a window outside the data span", async () => {
    const { count } = setup([
      {
        ...SUMMARY,
        events: "0",
        group_count: "0",
        other_groups: "0",
        other_events: "0",
        other_share: null,
      },
    ])
    const outcome = await count({
      group_by: ["component"],
      dataset: "openstack",
      from: "2018-01-01T00:00:00Z",
      to: "2018-02-01T00:00:00Z",
      components: ["nova-api"],
    })
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(outcome.result.data).toMatchObject({
      total: 0,
      group_count: 0,
      groups: [],
      other: null,
      truncated: false,
    })
    expect(outcome.result.notes).toEqual([
      "Counts are log events (parsed lines), not incidents or outages.",
      'Nothing in scope: 0 log events in openstack [2018-01-01T00:00:00Z, 2018-02-01T00:00:00Z) with components=["nova-api"].',
      "The openstack window lies outside its data span (2017-05-16T00:00:00.008000Z to 2017-05-16T00:14:47.687000Z): its count of 0 is not an observed zero (R-03).",
    ])
  })

  it("names a window that reaches beyond the data span", async () => {
    const { count } = setup()
    const outcome = await count({
      group_by: ["level"],
      dataset: "bgl",
      from: "2005-01-01T00:00:00Z",
    })
    expect(outcome.ok && outcome.result.notes).toContain(
      "The bgl window reaches beyond its data span (2005-06-03T22:42:50.675872Z to 2006-01-03T15:13:09.127918Z); only the observed part is counted."
    )
  })
})

const C_FROM = "2005-08-01T00:00:00Z"
const C_TO = "2005-09-01T00:00:00Z"

const COMPARED_SUMMARY: Row = {
  ...SUMMARY,
  events: "30",
  baseline: "12",
  delta: "18",
  pct_change: 150,
  group_count: "2",
  other_groups: "0",
  other_events: "0",
  other_share: 0,
  other_baseline: "0",
  other_delta: "0",
  other_pct_change: null,
}

const COMPARED_GROUPS: Row[] = [
  {
    ...GROUPS[0],
    g1: "KERNEL",
    g2: undefined,
    events: "30",
    share: 1,
    baseline: "10",
    delta: "20",
    pct_change: 200,
    classification: "significantly increased",
  },
  {
    ...GROUPS[0],
    g1: "APP",
    g2: undefined,
    events: "0",
    share: 0,
    baseline: "2",
    delta: "-2",
    pct_change: -100,
  },
]

describe("count_events compare", () => {
  const compareInput = {
    group_by: ["component"],
    dataset: "bgl",
    from: C_FROM,
    to: C_TO,
    compare: "previous_period",
  }

  it("counts both periods with the same filter in one statement", async () => {
    const { calls, stored, count } = setup([
      COMPARED_SUMMARY,
      ...COMPARED_GROUPS,
    ])
    const outcome = await count({ ...compareInput, only_errors: true })
    if (!outcome.ok) throw new Error(outcome.error.message)
    const coverage = toolCalls(calls).find((call) =>
      call.sql.startsWith("WITH comparison_bounds")
    )
    expect(coverage?.params).toEqual([
      C_FROM,
      C_TO,
      "2005-07-01T00:00:00.000000Z",
      "2005-08-01T00:00:00.000000Z",
      SPAN.bgl.first,
      SPAN.bgl.last,
    ])
    expect(coverage?.sql).toContain(
      "$6::TIMESTAMPTZ + INTERVAL '1 microsecond'"
    )
    const counted = toolCalls(calls).at(-1)
    const inC =
      "log_events.ts >= $2::TIMESTAMPTZ AND log_events.ts < $3::TIMESTAMPTZ"
    const inB =
      "log_events.ts >= $4::TIMESTAMPTZ AND log_events.ts < $5::TIMESTAMPTZ"
    expect(counted?.sql).toContain(
      `SELECT log_events.component AS g1, count(*) FILTER (WHERE ${inC}) AS events, count(*) FILTER (WHERE ${inB}) AS baseline FROM log_events WHERE log_events.dataset = $1 AND log_events.is_error AND ((${inC}) OR (${inB})) GROUP BY 1)`
    )
    expect(counted?.sql).toContain(
      "row_number() OVER (ORDER BY abs(events - baseline) DESC, events DESC, g1 ASC NULLS LAST) AS rank"
    )
    expect(counted?.sql).toContain(
      "coalesce(b, 0)::BIGINT AS baseline, (c - coalesce(b, 0))::BIGINT AS delta, 100 * (c - coalesce(b, 0))::DOUBLE / NULLIF(coalesce(b, 0), 0) AS pct_change"
    )
    // July has 31 days, like August.
    expect(counted?.params).toEqual([
      "bgl",
      C_FROM,
      C_TO,
      "2005-07-01T00:00:00.000000Z",
      "2005-08-01T00:00:00.000000Z",
      20,
      2,
      20,
    ])
    expect(counted?.sql).toContain("events >= $7::BIGINT * baseline")
    expect(counted?.sql).toContain("events - baseline >= $8::BIGINT")
    expect(stored[0]?.scope).toEqual({
      windows: [
        { dataset: "bgl", from: C_FROM, to: C_TO, period: "current" },
        {
          dataset: "bgl",
          from: "2005-07-01T00:00:00.000000Z",
          to: "2005-08-01T00:00:00.000000Z",
          period: "baseline",
        },
      ],
      filters: { only_errors: true },
    })
    expect(outcome.result.data).toMatchObject({
      total: 30,
      groups: [
        {
          component: "KERNEL",
          events: 30,
          baseline: 10,
          delta: 20,
          pct_change: 200,
          classification: "significantly increased",
        },
        {
          component: "APP",
          events: 0,
          baseline: 2,
          delta: -2,
          pct_change: -100,
          classification: null,
        },
      ],
      other: null,
      comparison: {
        reference: "previous_period",
        coverage: { current: "full", baseline: "full" },
        determinable: true,
        baseline: 12,
        delta: 18,
        pct_change: 150,
        classification: null,
      },
    })
  })

  it("uses the classification SQL returned without recalculating it", async () => {
    const { count } = setup([
      COMPARED_SUMMARY,
      { ...COMPARED_GROUPS[0], classification: null },
      COMPARED_GROUPS[1] ?? {},
    ])
    const outcome = await count(compareInput)
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(outcome.result.data).toMatchObject({
      groups: [{ events: 30, baseline: 10, classification: null }, {}],
    })
  })

  it("cites C, B, delta and change with the group and the period", async () => {
    const { count } = setup([COMPARED_SUMMARY, ...COMPARED_GROUPS])
    const outcome = await count(compareInput)
    if (!outcome.ok) throw new Error(outcome.error.message)
    const fact = (path: string) =>
      outcome.result.facts.find((candidate) => candidate.path === path)
    expect(fact("/result/groups/0/events")).toMatchObject({
      metric: "events_current",
      group: { component: "KERNEL" },
    })
    expect(fact("/result/groups/0/baseline")).toMatchObject({
      value: 10,
      metric: "events_baseline",
      unit: "log_events",
    })
    expect(fact("/result/groups/0/delta")).toMatchObject({
      value: 20,
      metric: "delta",
    })
    expect(fact("/result/groups/0/pct_change")).toMatchObject({
      value: 200,
      metric: "pct_change",
      unit: "percent",
    })
    expect(fact("/result/comparison/baseline")).toMatchObject({
      value: 12,
      metric: "events_baseline",
      group: {},
    })
    expect(fact("/result/total")).toMatchObject({ metric: "events_current" })
    expect(fact("/scope/windows/1/from")).toMatchObject({
      group: { dataset: "bgl", period: "baseline" },
    })
    // B = 0 has no relative change, so no fact.
    expect(fact("/result/other/pct_change")).toBeUndefined()
  })

  it("does not count or classify a baseline outside the data span", async () => {
    const { calls, count } = setup([
      { ...SUMMARY, other_groups: "0", other_events: "0" },
      GROUPS[0] ?? {},
    ])
    const outcome = await count({
      group_by: ["component"],
      dataset: "bgl",
      from: "2005-06-03T00:00:00Z",
      to: "2005-06-04T00:00:00Z",
      compare: "previous_period",
    })
    if (!outcome.ok) throw new Error(outcome.error.message)
    const counted = toolCalls(calls).at(-1)
    expect(counted?.sql).toContain(
      "count(*) AS events, NULL::BIGINT AS baseline FROM log_events WHERE log_events.dataset = $1 AND log_events.ts >= $2::TIMESTAMPTZ AND log_events.ts < $3::TIMESTAMPTZ GROUP BY 1"
    )
    expect(counted?.sql).toContain("ORDER BY events DESC, g1 ASC NULLS LAST")
    expect(outcome.result.data).toMatchObject({
      groups: [
        {
          baseline: null,
          delta: null,
          pct_change: null,
          classification: null,
        },
      ],
      comparison: {
        coverage: { current: "partial", baseline: "none" },
        determinable: false,
        baseline: null,
        delta: null,
        pct_change: null,
        classification: null,
      },
    })
    expect(outcome.result.notes).toContain(
      "The comparison is not determinable: the baseline lies outside the bgl data span (2005-06-03T22:42:50.675872Z to 2006-01-03T15:13:09.127918Z). B, delta, pct_change and classification are null: no data is not an observed zero (R-03)."
    )
  })

  it("names a baseline only partly covered by data", async () => {
    const { count } = setup([COMPARED_SUMMARY, ...COMPARED_GROUPS])
    const outcome = await count({
      ...compareInput,
      from: "2005-06-04T00:00:00Z",
      to: "2005-06-05T00:00:00Z",
    })
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(outcome.result.data).toMatchObject({
      comparison: {
        coverage: { current: "full", baseline: "partial" },
        determinable: true,
      },
    })
    expect(outcome.result.notes).toContain(
      "The baseline is only partly covered by data (bgl data span 2005-06-03T22:42:50.675872Z to 2006-01-03T15:13:09.127918Z): B counts only the observed part, so the change is limited and may overstate an increase."
    )
  })

  it("accepts an equally long reference and rejects others", async () => {
    const { calls, count } = setup([COMPARED_SUMMARY, ...COMPARED_GROUPS])
    const outcome = await count({
      ...compareInput,
      compare: { from: "2005-10-01T00:00:00Z", to: "2005-11-01T00:00:00Z" },
    })
    expect(outcome.ok && outcome.result.data).toMatchObject({
      comparison: { reference: "custom" },
    })
    expect(toolCalls(calls).at(-1)?.params.slice(3, 5)).toEqual([
      "2005-10-01T00:00:00Z",
      "2005-11-01T00:00:00Z",
    ])

    expect(
      await issues({
        ...compareInput,
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
      await issues({
        ...compareInput,
        compare: { from: "2005-08-15T00:00:00Z", to: "2005-09-15T00:00:00Z" },
      })
    ).toMatchObject({
      issues: [
        {
          path: "compare",
          message: "The reference must not overlap [from, to).",
        },
      ],
    })
    expect(
      await issues({
        ...compareInput,
        compare: { from: "2005-07-01T00:00:00.0000001Z", to: C_FROM },
      })
    ).toMatchObject({ issues: [{ path: "compare.from" }] })
  })

  it("needs one dataset, a window, one dimension and top_n ≤ 25", async () => {
    const error = await issues({
      group_by: ["component", "level"],
      from: C_FROM,
      compare: "previous_period",
      top_n: 26,
    })
    expect(error).toMatchObject({
      code: "invalid_input",
      issues: [
        {
          path: "dataset",
          message:
            "compare needs exactly one dataset: comparisons run within one dataset; no two datasets share a time axis.",
        },
        { path: "to" },
        {
          path: "group_by",
          message: "compare groups by exactly one dimension; 2 given.",
        },
        { path: "top_n", message: "With compare top_n is at most 25." },
      ],
    })
    expect(error?.hint).toMatch(/^compare needs one dataset/)
  })
})
