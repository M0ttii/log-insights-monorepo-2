import type { Receipt } from "@workspace/domain/receipt"
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

const SUMMARY: Row = {
  rank: "0",
  g1: null,
  g2: null,
  events: "10",
  share: null,
  group_count: "3",
  other_groups: "1",
  other_events: "2",
  other_share: 0.2,
}

const GROUPS: Row[] = [
  {
    rank: "1",
    g1: "bgl",
    g2: "Compute Platform",
    events: "5",
    share: 0.5,
    group_count: null,
    other_groups: null,
    other_events: null,
    other_share: null,
  },
  {
    rank: "2",
    g1: "openstack",
    g2: "unowned",
    events: "3",
    share: 0.3,
    group_count: null,
    other_groups: null,
    other_events: null,
    other_share: null,
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
        if (sql.includes("FROM corpus_stats")) {
          const dataset = params[0] === "openstack" ? "openstack" : "bgl"
          return [SPAN[dataset]]
        }
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
    const [bglSpan, openstackSpan, counted] = toolCalls(calls)
    expect([bglSpan?.params, openstackSpan?.params]).toEqual([
      ["bgl"],
      ["openstack"],
    ])
    expect(counted).toEqual({
      sql: `WITH grouped AS (SELECT log_events.dataset AS g1, ${TEAM} AS g2, count(*) AS events FROM log_events WHERE log_events.is_error GROUP BY 1, 2), ranked AS (SELECT g1, g2, events, row_number() OVER (ORDER BY events DESC, g1 ASC NULLS LAST, g2 ASC NULLS LAST) AS rank, sum(events) OVER () AS total FROM grouped) SELECT 0::BIGINT AS rank, NULL AS g1, NULL AS g2, coalesce(sum(events), 0)::BIGINT AS events, NULL::DOUBLE AS share, count(*)::BIGINT AS group_count, (count(*) FILTER (WHERE rank > $1))::BIGINT AS other_groups, coalesce(sum(events) FILTER (WHERE rank > $1), 0)::BIGINT AS other_events, coalesce(sum(events) FILTER (WHERE rank > $1), 0)::DOUBLE / NULLIF(sum(events), 0) AS other_share FROM ranked UNION ALL SELECT rank, g1, g2, events, events::DOUBLE / total, NULL, NULL, NULL, NULL FROM ranked WHERE rank <= $1 ORDER BY rank`,
      params: [2],
    })
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
      "SELECT log_events_idx.level AS g1, count(*) AS events FROM log_events_idx WHERE log_events_idx.dataset = $1 AND log_events_idx.ts >= $2::TIMESTAMPTZ AND log_events_idx.ts < $3::TIMESTAMPTZ AND log_events_idx.message @@ plainto_tsquery($4) GROUP BY 1)"
    )
    expect(counted?.sql).toContain("WHERE rank <= $5 ORDER BY rank")
    expect(counted?.params).toEqual([
      "bgl",
      "2005-06-01T00:00:00Z",
      "2005-07-01T00:00:00Z",
      "cache parity",
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
      "SELECT log_events.http_status AS g1, log_events.component AS g2, count(*) AS events FROM log_events WHERE log_events.dataset = 'openstack' AND log_events.http_status IS NOT NULL GROUP BY 1, 2"
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

  it("bounds top_n to 1–50 and rejects compare until it exists", async () => {
    expect(await issues({ group_by: ["level"], top_n: 0 })).toMatchObject({
      code: "invalid_input",
    })
    expect(await issues({ group_by: ["level"], top_n: 51 })).toMatchObject({
      code: "invalid_input",
    })
    expect(
      await issues({ group_by: ["level"], compare: "previous_period" })
    ).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "compare", message: "Unsupported field." }],
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
      hint: "http_status and endpoint count OpenStack API accesses: group or filter by BGL fields in a separate call.",
      issues: [
        {
          path: "group_by",
          message:
            "node is BGL-only; http_status counts OpenStack API accesses.",
        },
        {
          path: "dataset",
          message:
            "http_status counts OpenStack API accesses; use dataset openstack or leave it out.",
        },
        {
          path: "only_alerts",
          message: "BGL-only; http_status counts OpenStack API accesses.",
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
