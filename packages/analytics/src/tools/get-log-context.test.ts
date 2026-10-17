import type { Receipt } from "@workspace/domain/receipt"
import { describe, expect, it } from "vitest"

import { createRegistry } from "../registry.ts"

/**
 * get_log_context against a fake database: the SQL it sends per mode, the
 * cross-field rules and the result envelope. Behaviour against SereneDB is
 * covered by tests/integration/get-log-context*.test.ts.
 */

const ANCHOR = {
  event_id: "5",
  dataset: "bgl",
  ts: "2005-07-01T12:00:00.000000Z",
  component: "KERNEL",
  level: "INFO",
  node: "R01-M0-N0-C:J02-U01",
  alert_label: null,
  request_id: null,
  pattern_id: "aaaa",
  message: "anchor",
  message_truncated: false,
}

const neighbour = (event_id: string, offset_ms: number) => ({
  ...ANCHOR,
  event_id,
  offset_ms,
})

type Call = { sql: string; params: readonly unknown[] }

type Answers = {
  anchor?: Record<string, unknown> | null
  counts?: { before: string; after: string }
  before?: Record<string, unknown>[]
  after?: Record<string, unknown>[]
  summary?: Record<string, unknown>
  patterns?: Record<string, unknown>[]
  tokens?: string[]
}

function setup(answers: Answers = {}) {
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
          return [{ tokens: answers.tokens ?? ["terminated"] }]
        if (sql.includes("FROM corpus_stats"))
          return [
            {
              first: "2005-06-03T22:42:50.363779Z",
              last: "2006-01-04T16:00:05.233639Z",
            },
          ]
        if (sql.includes("WHERE log_events.event_id = $1")) {
          const anchor = answers.anchor === undefined ? ANCHOR : answers.anchor
          return anchor === null ? [] : [anchor]
        }
        if (sql.includes("count(*) FILTER"))
          return [answers.counts ?? { before: "1", after: "0" }]
        if (sql.includes("ORDER BY log_events.ts DESC"))
          return answers.before ?? [neighbour("4", -2.5)]
        if (sql.includes("ORDER BY log_events.ts, log_events.event_id"))
          return answers.after ?? []
        if (sql.includes("AS matched_events"))
          return [
            answers.summary ?? {
              matched_events: "55",
              anchors: "4",
              excluded_patterns: "1",
              grid_windows: "30920",
            },
          ]
        if (sql.includes("hits AS")) return answers.patterns ?? []
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
  const context = (input: unknown) =>
    registry.runTool("get_log_context", input, {
      client: "test",
      signal: new AbortController().signal,
    })
  const toolCalls = () =>
    calls.filter((call) => !call.sql.includes("load_manifest"))
  return { calls, stored, context, toolCalls, registry }
}

describe("get_log_context catalog entry", () => {
  it("is registered after search_logs with a flat object input schema", () => {
    const { registry } = setup()
    const entry = registry
      .catalog()
      .find((tool) => tool.name === "get_log_context")
    expect(registry.tools.map((tool) => tool.name).slice(0, 3)).toEqual([
      "describe_corpus",
      "search_logs",
      "get_log_context",
    ])
    // The catalog exports with io "output", where window_minutes has its default.
    expect(entry?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["mode", "window_minutes"],
    })
    expect(entry?.inputSchema).not.toHaveProperty("oneOf")
    expect(entry?.description).toContain(
      "Precursors are temporal observations, not causes"
    )
    expect(entry?.description).toContain(
      "Do not use when: you need how often a pattern or message occurs (use count_events or recurring_patterns)"
    )
    expect(entry?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
    // The output envelope's root is an object, too.
    expect(entry?.outputSchema).toMatchObject({ type: "object" })
  })
})

describe("mode event SQL", () => {
  it("loads the anchor, counts both sides and lists the nearest events", async () => {
    const { context, toolCalls } = setup()
    const outcome = await context({
      mode: "event",
      event_id: "5",
      before: 3,
      after: 2,
      window_minutes: 5,
    })
    expect(outcome.ok).toBe(true)
    const [anchor, counts, before, after] = toolCalls()
    expect(anchor?.params).toEqual([5])
    // $1 anchor time, $2 anchor event_id, $3 window.
    const where = {
      before:
        "log_events.ts >= $1::TIMESTAMPTZ - $3::INTERVAL AND (log_events.ts < $1::TIMESTAMPTZ OR (log_events.ts = $1::TIMESTAMPTZ AND log_events.event_id < $2))",
      after:
        "log_events.ts <= $1::TIMESTAMPTZ + $3::INTERVAL AND (log_events.ts > $1::TIMESTAMPTZ OR (log_events.ts = $1::TIMESTAMPTZ AND log_events.event_id > $2))",
    }
    expect(counts).toEqual({
      sql: `SELECT count(*) FILTER (WHERE ${where.before}) AS before, count(*) FILTER (WHERE ${where.after}) AS after FROM log_events WHERE log_events.dataset = $4 AND log_events.node = $5 AND ((${where.before}) OR (${where.after}))`,
      params: [ANCHOR.ts, 5, "5 minutes", "bgl", ANCHOR.node],
    })
    expect(before?.sql).toContain(
      `(epoch_us(log_events.ts) - epoch_us($1::TIMESTAMPTZ))::DOUBLE / 1000 AS offset_ms FROM log_events WHERE log_events.dataset = $4 AND log_events.node = $5 AND ${where.before} ORDER BY log_events.ts DESC, log_events.event_id DESC LIMIT $6`
    )
    expect(before?.params).toEqual([
      ANCHOR.ts,
      5,
      "5 minutes",
      "bgl",
      ANCHOR.node,
      3,
    ])
    expect(after?.sql).toContain(
      `AND ${where.after} ORDER BY log_events.ts, log_events.event_id LIMIT $6`
    )
    expect(after?.params.at(-1)).toBe(2)
  })

  it("returns nearest-first rows in ascending order", async () => {
    const { context } = setup({
      counts: { before: "3", after: "0" },
      before: [neighbour("4", -1), neighbour("3", -20), neighbour("2", -300)],
    })
    const outcome = await context({ mode: "event", event_id: 5, before: 3 })
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(outcome.result.data).toMatchObject({
      events_before: [{ event_id: 2 }, { event_id: 3 }, { event_id: 4 }],
      sides: [
        { direction: "before", in_window: 3, returned: 3, truncated: false },
        { direction: "after", in_window: 0, returned: 0, truncated: false },
      ],
    })
  })

  it("filters on the component or nothing for the other scopes", async () => {
    const component = setup()
    await component.context({
      mode: "event",
      event_id: 5,
      scope: "same_component",
    })
    expect(component.toolCalls()[1]?.sql).toContain(
      "WHERE log_events.dataset = $4 AND log_events.component = $5 AND"
    )
    const dataset = setup()
    await dataset.context({ mode: "event", event_id: 5, scope: "dataset" })
    expect(dataset.toolCalls()[1]?.sql).toContain(
      "FROM log_events WHERE log_events.dataset = $4 AND (("
    )
    expect(dataset.stored[0]?.scope.filters).toEqual({})
  })

  it("answers not_found for an unknown event and stops", async () => {
    const { context, toolCalls } = setup({ anchor: null })
    const outcome = await context({ mode: "event", event_id: 42 })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "not_found",
      resource: "event",
      id: "42",
    })
    expect(toolCalls()).toHaveLength(1)
  })

  it("rejects same_request for BGL before querying the neighbours", async () => {
    const { context, toolCalls } = setup()
    const outcome = await context({
      mode: "event",
      event_id: 5,
      scope: "same_request",
    })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      issues: [
        {
          path: "scope",
          message:
            "same_request is only available for OpenStack events; BGL has no request IDs.",
        },
      ],
    })
    expect(toolCalls()).toHaveLength(1)
  })

  it("rejects fields of mode aggregate without touching the database", async () => {
    const { context, calls } = setup()
    const outcome = await context({
      mode: "event",
      event_id: 5,
      dataset: "bgl",
    })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "dataset" }],
    })
    expect(calls).toEqual([])
  })
})

const PATTERN_ROW = {
  direction: "before",
  patterns_found: "1",
  pattern_id: "bbbb",
  pattern: "ddr error",
  pattern_truncated: false,
  component: "KERNEL",
  team: "Compute Platform",
  anchors_with_pattern: "2",
  anchor_share: 0.5,
  base_rate_windows: null,
  base_rate: null,
  ratio: null,
  example_event_id: "2",
}

describe("mode aggregate SQL", () => {
  it("reads a pattern anchor from the table and omits the grid below five anchors", async () => {
    const { context, toolCalls } = setup({ patterns: [PATTERN_ROW] })
    const outcome = await context({
      mode: "aggregate",
      dataset: "bgl",
      pattern_id: "aaaa0000",
      node: "R01-M0-N0-C:J02-U01",
    })
    if (!outcome.ok) throw new Error(outcome.error.message)
    const [span, summary, patterns] = toolCalls()
    expect(span?.sql).toContain("FROM corpus_stats")
    expect(summary?.sql).toBe(
      "WITH matched AS (SELECT log_events.event_id, log_events.ts, log_events.pattern_id FROM log_events WHERE log_events.dataset = $1 AND log_events.node = $2 AND log_events.pattern_id = $3), anchors AS (SELECT event_id, ts FROM (SELECT event_id, ts, lag(ts) OVER (ORDER BY ts, event_id) AS prev_ts FROM matched) s WHERE prev_ts IS NULL OR ts - prev_ts >= $4::INTERVAL) SELECT (SELECT count(*) FROM matched) AS matched_events, (SELECT count(*) FROM anchors) AS anchors, (SELECT count(DISTINCT pattern_id) FROM matched) AS excluded_patterns, (epoch_us($5::TIMESTAMPTZ) - epoch_us($6::TIMESTAMPTZ) + $7::BIGINT - 1) // $8::BIGINT AS grid_windows"
    )
    expect(summary?.params).toEqual([
      "bgl",
      "R01-M0-N0-C:J02-U01",
      "aaaa0000",
      "30 minutes",
      "2006-01-04T16:00:05.233640Z",
      "2005-06-03T22:42:50.363779Z",
      600_000_000,
      600_000_000,
    ])
    expect(patterns?.sql).toContain(
      "FROM anchors a JOIN log_events e ON e.dataset = $5 AND e.ts >= a.ts - $6::INTERVAL AND e.ts < a.ts WHERE e.pattern_id NOT IN (SELECT pattern_id FROM excluded)"
    )
    expect(patterns?.sql).not.toContain("grid AS")
    expect(patterns?.sql).toContain("NULL::DOUBLE AS base_rate")
    expect(outcome.result.data).toMatchObject({
      mode: "aggregate",
      anchors: 4,
      base_rate_grid: null,
      by_direction: [
        {
          direction: "before",
          patterns_found: 1,
          truncated: false,
          patterns: [
            {
              pattern_id: "bbbb",
              anchors_with_pattern: 2,
              example_event_id: 2,
            },
          ],
        },
      ],
    })
  })

  it("reads a query anchor from the index and adds the grid from five anchors", async () => {
    const { context, toolCalls } = setup({
      summary: {
        matched_events: "60",
        anchors: "5",
        excluded_patterns: "2",
        grid_windows: "30920",
      },
    })
    const outcome = await context({
      mode: "aggregate",
      dataset: "bgl",
      query: "kernel terminated",
      direction: "both",
    })
    if (!outcome.ok) throw new Error(outcome.error.message)
    const [tokenize, , summary, patterns] = toolCalls()
    expect(tokenize?.params).toEqual(["kernel terminated"])
    expect(summary?.sql).toContain(
      "FROM log_events_idx WHERE log_events_idx.dataset = $1 AND log_events_idx.message @@ plainto_tsquery($2)"
    )
    expect(patterns?.sql).toContain(" UNION ALL ")
    expect(patterns?.sql).toContain("e.ts > a.ts AND e.ts <= a.ts + $")
    expect(patterns?.sql).toContain(
      "count(DISTINCT (epoch_us(e.ts) - epoch_us($"
    )
    expect(outcome.result.data).toMatchObject({
      direction: "both",
      base_rate_grid: {
        from: "2005-06-03T22:42:50.363779Z",
        to: "2006-01-04T16:00:05.233640Z",
        windows: 30_920,
      },
    })
  })

  it("skips the pattern query without anchors", async () => {
    const { context, toolCalls } = setup({
      summary: {
        matched_events: "0",
        anchors: "0",
        excluded_patterns: "0",
        grid_windows: "30920",
      },
    })
    const outcome = await context({
      mode: "aggregate",
      dataset: "bgl",
      pattern_id: "abcdef01",
    })
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(toolCalls()).toHaveLength(2)
    expect(outcome.result.data).toMatchObject({
      anchors: 0,
      by_direction: [{ patterns: [], patterns_found: 0 }],
    })
  })

  it("rejects a query without searchable words", async () => {
    const { context, toolCalls } = setup({ tokens: [] })
    const outcome = await context({
      mode: "aggregate",
      dataset: "bgl",
      query: "--",
    })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "query" }],
    })
    expect(toolCalls()).toHaveLength(1)
  })
})
