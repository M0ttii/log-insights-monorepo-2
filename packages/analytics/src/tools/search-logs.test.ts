import type { Receipt } from "@workspace/domain/receipt"
import { describe, expect, it } from "vitest"

import { createRegistry } from "../registry.ts"

/**
 * search_logs against a fake database: the SQL it sends, the cross-field
 * rules and the result envelope. Behaviour against SereneDB is covered by
 * tests/integration/search-logs.test.ts.
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

const HIT = {
  event_id: "3",
  dataset: "bgl",
  ts: "2005-06-03T23:00:00.000000Z",
  component: "KERNEL",
  level: "INFO",
  node: "R02-M1-N0",
  alert_label: null,
  request_id: null,
  message: "instruction cache parity error corrected",
  message_truncated: false,
  match_offsets: [18, 24],
  score: 2.5,
}

type Call = { sql: string; params: readonly unknown[] }

function setup(
  answers: {
    tokens?: string[]
    total?: string
    hits?: Record<string, unknown>[]
  } = {}
) {
  const calls: Call[] = []
  const stored: Receipt[] = []
  const db = {
    timeoutMs: 10_000,
    async query(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params })
      const rows = ((): Record<string, unknown>[] => {
        if (sql === "SELECT data_version FROM load_manifest")
          return [{ data_version: "dv_test" }]
        if (sql.includes("ts_lexize"))
          return [{ tokens: answers.tokens ?? ["parity"] }]
        if (sql.includes("FROM corpus_stats")) {
          const dataset = params[0] === "openstack" ? "openstack" : "bgl"
          return [SPAN[dataset]]
        }
        if (sql.startsWith("SELECT count(*)"))
          return [{ total: answers.total ?? "1" }]
        if (sql.includes("BM25")) return answers.hits ?? [HIT]
        throw new Error(`unexpected SQL: ${sql}`)
      })()
      return { rows, durationMs: 1 }
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
  const search = (input: unknown) =>
    registry.runTool("search_logs", input, {
      client: "test",
      signal: new AbortController().signal,
    })
  return { calls, stored, search }
}

const toolCalls = (calls: Call[]) =>
  calls.filter((call) => !call.sql.includes("load_manifest"))

describe("search_logs SQL", () => {
  it("stores the same normalized input and signature for implicit and explicit fuzzy defaults", async () => {
    const { stored, search } = setup({ tokens: ["parrity"] })
    const input = { query: "parrity", match: "fuzzy", dataset: "bgl" }
    expect((await search(input)).ok).toBe(true)
    expect((await search({ ...input, max_edits: 1 })).ok).toBe(true)
    expect(stored).toHaveLength(2)
    expect(stored[0]?.input).toMatchObject({ ...input, max_edits: 1 })
    expect(stored[0]?.input).toEqual(stored[1]?.input)
    expect(stored[0]?.signature).toBe(stored[1]?.signature)
    expect(stored[0]?.params).toEqual(stored[1]?.params)
    expect(stored[0]?.result_digest).toBe(stored[1]?.result_digest)
  })

  it("counts and lists with the same condition; the list adds only the limit", async () => {
    const { calls, search } = setup()
    const outcome = await search({
      query: "cache parity",
      dataset: "bgl",
      from: "2005-06-01T00:00:00Z",
      to: "2005-07-01T00:00:00Z",
      levels: ["INFO"],
      components: ["KERNEL"],
      limit: 5,
    })
    expect(outcome.ok).toBe(true)
    const [tokenize, span, count, list] = toolCalls(calls)
    expect(tokenize).toEqual({
      sql: "SELECT ts_lexize('log_text', $1::VARCHAR) AS tokens",
      params: ["cache parity"],
    })
    expect(span?.params).toEqual(["bgl"])
    const where =
      "log_events_idx.message @@ plainto_tsquery($1) AND log_events_idx.dataset = $2 AND log_events_idx.ts >= $3::TIMESTAMPTZ AND log_events_idx.ts < $4::TIMESTAMPTZ AND log_events_idx.component IN ($5) AND log_events_idx.level IN ($6)"
    expect(count).toEqual({
      sql: `SELECT count(*) AS total FROM log_events_idx WHERE ${where}`,
      params: [
        "cache parity",
        "bgl",
        "2005-06-01T00:00:00Z",
        "2005-07-01T00:00:00Z",
        "KERNEL",
        "INFO",
      ],
    })
    expect(list?.sql).toContain(
      `FROM log_events_idx WHERE ${where} ORDER BY BM25(log_events_idx.tableoid) DESC, log_events_idx.event_id LIMIT $7`
    )
    expect(list?.params).toEqual([...(count?.params ?? []), 5])
  })

  it("orders by time with event_id as the last tiebreaker", async () => {
    for (const [sort, order] of [
      ["time_asc", "ORDER BY log_events_idx.ts, log_events_idx.event_id LIMIT"],
      [
        "time_desc",
        "ORDER BY log_events_idx.ts DESC, log_events_idx.event_id DESC LIMIT",
      ],
    ] as const) {
      const { calls, search } = setup()
      await search({ query: "parity", sort })
      expect(toolCalls(calls).at(-1)?.sql).toContain(order)
    }
  })

  it("uses ts_phrase for phrase and the dictionary token for fuzzy", async () => {
    const phrase = setup()
    await phrase.search({ query: "Cache Parity", match: "phrase" })
    expect(toolCalls(phrase.calls).at(-2)?.sql).toBe(
      "SELECT count(*) AS total FROM log_events_idx WHERE log_events_idx.message @@ ts_phrase($1)"
    )

    const fuzzy = setup({ tokens: ["parrity"] })
    const outcome = await fuzzy.search({ query: "PARRITY", match: "fuzzy" })
    expect(toolCalls(fuzzy.calls).at(-2)).toEqual({
      sql: "SELECT count(*) AS total FROM log_events_idx WHERE log_events_idx.message @@ ts_levenshtein($1::VARCHAR, $2::INTEGER)",
      params: ["parrity", 1],
    })
    expect(outcome.ok && outcome.result.data).toMatchObject({
      match_mode: "fuzzy",
      max_edits: 1,
    })
  })

  it("reads both data spans without a dataset", async () => {
    const { calls, stored, search } = setup()
    await search({ query: "parity" })
    expect(
      toolCalls(calls)
        .filter((call) => call.sql.includes("corpus_stats"))
        .map((call) => call.params)
    ).toEqual([["bgl"], ["openstack"]])
    expect(stored[0]?.scope.windows).toEqual([
      {
        dataset: "bgl",
        from: SPAN.bgl.first,
        to: "2006-01-03T15:13:09.127919Z",
      },
      {
        dataset: "openstack",
        from: SPAN.openstack.first,
        to: "2017-05-16T00:14:47.687001Z",
      },
    ])
  })
})

describe("search_logs validation", () => {
  it.each([undefined, "terms", "phrase"])(
    "rejects max_edits with match %s",
    async (match) => {
      const { calls, search } = setup()
      const outcome = await search({ query: "parity", match, max_edits: 1 })
      expect(outcome.ok ? null : outcome.error).toMatchObject({
        code: "invalid_input",
        issues: [{ path: "max_edits" }],
      })
      expect(calls).toEqual([])
    }
  )

  it("rejects OpenStack-only filters with dataset bgl and reversed windows", async () => {
    const { search } = setup()
    const outcome = await search({
      query: "parity",
      dataset: "bgl",
      request_id: "req-1",
      from: "2005-06-02T00:00:00Z",
      to: "2005-06-01T00:00:00Z",
    })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      issues: [
        { path: "to" },
        {
          path: "request_id",
          message: "Only available for dataset openstack.",
        },
      ],
    })
  })

  it("rejects a query without searchable words before searching", async () => {
    const { calls, search } = setup({ tokens: [] })
    const outcome = await search({ query: " -- !!! " })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "query" }],
    })
    expect(toolCalls(calls).map((call) => call.sql)).toEqual([
      "SELECT ts_lexize('log_text', $1::VARCHAR) AS tokens",
    ])
  })

  it("rejects fuzzy with more than one term", async () => {
    const { search } = setup({ tokens: ["r02", "m1", "n0"] })
    const outcome = await search({ query: "R02-M1-N0", match: "fuzzy" })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      issues: [
        {
          path: "query",
          message:
            'match "fuzzy" takes exactly one term; the query splits into 3 terms (r02, m1, n0).',
        },
      ],
    })
  })
})

describe("search_logs result", () => {
  it("reports truncation, population and facts", async () => {
    const { stored, search } = setup({ total: "48" })
    const outcome = await search({ query: "parity", limit: 1 })
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(outcome.result.data).toMatchObject({
      total_matches: 48,
      truncated: true,
      row_limit: 1,
      hits: [{ event_id: 3, message_truncated: false }],
    })
    expect(stored[0]).toMatchObject({
      population: { count: 48, unit: "log_events" },
      rows_returned: 1,
      truncated: true,
      row_limit: 1,
    })
    const id = outcome.result.receipt.receipt_id
    expect(
      outcome.result.facts.map(({ id: factId, ...fact }) => [factId, fact])
    ).toEqual([
      [
        `${id}.f1`,
        {
          path: "/result/hits/0/ts",
          value: HIT.ts,
          metric: "event_time",
          unit: "utc_time",
          group: { event_id: "3" },
        },
      ],
      [
        `${id}.f2`,
        {
          path: "/result/total_matches",
          value: 48,
          metric: "matches",
          unit: "log_events",
          group: {},
        },
      ],
      [
        `${id}.f3`,
        {
          path: "/scope/windows/0/from",
          value: SPAN.bgl.first,
          metric: "window_start",
          unit: "utc_time",
          group: { dataset: "bgl" },
        },
      ],
      [
        `${id}.f4`,
        {
          path: "/scope/windows/0/to",
          value: "2006-01-03T15:13:09.127919Z",
          metric: "window_end",
          unit: "utc_time",
          group: { dataset: "bgl" },
        },
      ],
      [`${id}.f5`, expect.objectContaining({ path: "/scope/windows/1/from" })],
      [`${id}.f6`, expect.objectContaining({ path: "/scope/windows/1/to" })],
    ])
    expect(outcome.result.notes).toContain(
      "Truncated: 1 of 48 matches shown; total_matches is exact. Narrow the query, window or filters to see other lines, and use count_events for frequencies."
    )
  })

  it.each([[1], [9, 8], [8, 13, 7, 10], [1, 4]])(
    "rejects malformed index byte offsets %j instead of publishing wrong ranges",
    async (...offsets) => {
      const { search } = setup({
        hits: [{ ...HIT, message: "😀 ä cache", match_offsets: offsets }],
      })
      await expect(search({ query: "cache" })).rejects.toThrow(
        "failed unexpectedly"
      )
    }
  )

  it("names the scope when nothing matches (S-07)", async () => {
    const { search } = setup({ total: "0", hits: [] })
    const outcome = await search({
      query: "zzz",
      dataset: "openstack",
      components: ["nova-api"],
    })
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(outcome.result.data).toMatchObject({
      total_matches: 0,
      hits: [],
      truncated: false,
    })
    expect(outcome.result.notes).toEqual([
      "Matches are log events, not incidents; do not infer frequencies from hits – use count_events.",
      'No matching events for "zzz" (match terms) in openstack [2017-05-16T00:00:00.008000Z, 2017-05-16T00:14:47.687001Z) with components=["nova-api"].',
    ])
  })

  it("treats a NULL message as not cut", async () => {
    const { search } = setup({
      hits: [{ ...HIT, message: null, message_truncated: null }],
    })
    const outcome = await search({ query: "parity" })
    expect(outcome.ok && outcome.result.data).toMatchObject({
      hits: [{ message: null, message_truncated: false, match_ranges: [] }],
    })
  })
})
