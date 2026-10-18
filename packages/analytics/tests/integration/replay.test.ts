/**
 * Bounded OTLP replay through the real registry (LOG-35). The loader suite
 * leaves the committed 365-record fixture in log_insights_samples_otel.
 * Independent SQL here reads the received table, never the tool relation.
 */
import { rm } from "node:fs/promises"

import { DATASETS } from "@workspace/domain/datasets"
import { countEventsOutputSchema } from "@workspace/domain/tools/count-events"
import { eventTrendOutputSchema } from "@workspace/domain/tools/event-trend"
import { eventContextOutputSchema } from "@workspace/domain/tools/get-log-context"
import { searchLogsOutputSchema } from "@workspace/domain/tools/search-logs"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import { describeCorpus } from "../../src/tools/describe-corpus.ts"
import { loadEnv, otelSamplesConnection, temporaryDir } from "./helpers.ts"

loadEnv()

let db: Database
let oracle: Client
let dir: string
let receipts: FileReceiptStore
let registry: Registry

beforeAll(async () => {
  db = createDatabase(otelSamplesConnection())
  oracle = new Client(otelSamplesConnection())
  await oracle.connect()
  await oracle.query("SET TimeZone = 'UTC'")
  dir = await temporaryDir("analytics-replay-")
  receipts = new FileReceiptStore(dir)
  registry = createRegistry({ db, receipts, log: () => undefined })
})

afterAll(async () => {
  await db.dispose()
  await oracle.end()
  await rm(dir, { recursive: true, force: true })
})

async function ok(tool: string, input: Record<string, unknown>) {
  const outcome = await registry.runTool(tool, input, {
    client: "test",
    signal: new AbortController().signal,
  })
  if (!outcome.ok)
    throw new Error(`${tool}: ${outcome.error.code} ${outcome.error.message}`)
  return outcome.result
}

const marked =
  "log_attributes ->> 'log_insights.replay_id' = (SELECT replay_id FROM otel_replay)"

describe("OTLP replay tools", () => {
  it("describes the bounded replay and excludes it from calls without an explicit dataset", async () => {
    const described = await ok("describe_corpus", {})
    const replay = describeCorpus.output
      .parse(described.data)
      .datasets.find((dataset) => dataset.dataset === "otel_replay")
    expect(replay).toMatchObject({
      dataset: "otel_replay",
      storage: "otlp_replay",
      events: 365,
      lines_read: null,
      patterns: null,
      replay: {
        records: 365,
        fixture: { sha256: DATASETS.otel_replay.replay.fixture.sha256 },
        listener_table: "otlp.otel_logs",
      },
    })
    const counted = await ok("count_events", { group_by: ["dataset"] })
    expect(
      countEventsOutputSchema
        .parse(counted.data)
        .groups.map((group) => group.dataset)
    ).toEqual(["bgl", "openstack"])
    expect(counted.notes.join(" ")).toMatch(
      /otel_replay (?:is|are) loaded but not included/
    )
  })

  it("searches and groups the same analyzer matches, with replay provenance and claim verification", async () => {
    const input = {
      dataset: "otel_replay",
      query: "called",
      limit: 5,
      sort: "time_asc",
    }
    const searched = await ok("search_logs", input)
    const hits = searchLogsOutputSchema.parse(searched.data)
    const counted = await ok("count_events", {
      dataset: "otel_replay",
      group_by: ["component"],
      text: "called",
    })
    const groups = countEventsOutputSchema.parse(counted.data)
    const expected = await oracle.query<{
      component: string | null
      n: string
    }>(
      `SELECT service_name AS component, count(*)::VARCHAR AS n FROM otlp.otel_logs WHERE ${marked} AND regexp_matches(lower(body), '(^|[^a-z0-9_])called([^a-z0-9_]|$)') GROUP BY service_name ORDER BY count(*) DESC, service_name`
    )
    expect(hits.total_matches).toBe(151)
    expect(groups.total).toBe(151)
    expect(
      groups.groups.map((group) => [group.component, group.events])
    ).toEqual(expected.rows.map((row) => [row.component, Number(row.n)]))
    for (const hit of hits.hits) {
      const { rows } = await oracle.query<{ ts: string; body: string }>(
        `SELECT strftime("timestamp", '%Y-%m-%dT%H:%M:%S.%fZ') AS ts, left(body, 400) AS body FROM otlp.otel_logs WHERE ${marked} AND (log_attributes ->> 'log_insights.fixture_row')::BIGINT = $1::BIGINT`,
        [hit.event_id - 2_000_000_000_000]
      )
      expect(hit.ts).toBe(rows[0]?.ts)
      expect(hit.message).toBe(rows[0]?.body)
      expect(hit.ts).toMatch(/\.\d{6}Z$/)
    }
    expect(searched.receipt.source).toMatchObject({
      dataset: "otel_replay",
      kind: "otlp_replay",
      records: 365,
      fixture: { sha256: DATASETS.otel_replay.replay.fixture.sha256 },
      listener_table: "otlp.otel_logs",
      index: { name: "otel_replay_idx" },
    })
    expect((await receipts.get(searched.receipt.receipt_id))?.source).toEqual(
      searched.receipt.source
    )
    expect(searched.notes.join(" ")).toContain(
      "observed_timestamp is the replay time"
    )
    const fact = searched.facts.find((item) => item.metric === "matches")
    if (fact === undefined) throw new Error("no matches fact")
    const checked = await ok("check_claims", {
      claims: [
        { fact: fact.id, value: 151, metric: fact.metric, group: fact.group },
      ],
    })
    expect(checked.data).toMatchObject({
      summary: { checked: 1, verified: 1, mismatch: 0, unresolved: 0 },
    })
    expect((await ok("search_logs", input)).receipt.result_digest).toBe(
      searched.receipt.result_digest
    )
  })

  it("preserves nanoseconds through the search join and uses event IDs only for exact ties", async () => {
    // Keep the replay fixture untouched. A test-only runner redirects the
    // replay relation to a small real index in this same samples database.
    const orderedDb: Pick<Database, "query" | "timeoutMs"> = {
      timeoutMs: db.timeoutMs,
      query: (sql, params, signal) =>
        db.query(
          sql.replaceAll("otel_replay_idx", "replay_sort_idx"),
          params,
          signal
        ),
    }
    const ordered = createRegistry({
      db: orderedDb,
      receipts,
      log: () => undefined,
    })
    await oracle.query("DROP INDEX IF EXISTS replay_sort_idx")
    await oracle.query("DROP TABLE IF EXISTS replay_sort_events")
    try {
      await oracle.query(
        "CREATE TABLE replay_sort_events AS SELECT * FROM otel_replay_events WHERE FALSE"
      )
      await oracle.query(`INSERT INTO replay_sort_events (event_id, dataset, ts, message) VALUES
        (2000000000000, 'otel_replay', '2025-09-23T00:20:00.000000900Z'::TIMESTAMPTZ_NS, 'nanosecond order regression'),
        (2000000000001, 'otel_replay', '2025-09-23T00:20:00.000000100Z'::TIMESTAMPTZ_NS, 'nanosecond order regression'),
        (2000000000002, 'otel_replay', '2025-09-23T00:20:00.000000100Z'::TIMESTAMPTZ_NS, 'nanosecond order regression')`)
      await oracle.query(
        "CREATE INDEX replay_sort_idx ON replay_sort_events USING inverted (component, level, trace_id, message log_text) WITH (optimize_top_k = 'bm25(1.2, 0.75)')"
      )
      for (const [sort, ids] of [
        ["time_asc", [2000000000001, 2000000000002, 2000000000000]],
        ["time_desc", [2000000000000, 2000000000002, 2000000000001]],
      ] as const) {
        const outcome = await ordered.runTool(
          "search_logs",
          { dataset: "otel_replay", query: "regression", sort },
          { client: "test", signal: new AbortController().signal }
        )
        if (!outcome.ok) throw new Error(outcome.error.message)
        const data = searchLogsOutputSchema.parse(outcome.result.data)
        expect(data.hits.map((hit) => hit.event_id)).toEqual(ids)
        expect(data.hits.map((hit) => hit.ts)).toEqual(
          Array(3).fill("2025-09-23T00:20:00.000000Z")
        )
        expect(data.hits.every((hit) => !("sort_ts" in hit))).toBe(true)
      }
    } finally {
      await oracle.query("DROP INDEX IF EXISTS replay_sort_idx")
      await oracle.query("DROP TABLE IF EXISTS replay_sort_events")
    }
  })

  it("trends original UTC record time and applies half-open microsecond bounds", async () => {
    const trend = eventTrendOutputSchema.parse(
      (
        await ok("event_trend", {
          dataset: "otel_replay",
          bucket: "second",
          split_by: "level",
        })
      ).data
    )
    expect(trend.total).toBe(365)
    expect(trend.buckets).toHaveLength(1)
    expect(trend.buckets[0]).toMatchObject({
      bucket_start: "2025-09-23T00:20:00.000000Z",
      events: 365,
      partial: true,
    })
    const from = "2025-09-23T00:20:00.000100Z"
    const to = "2025-09-23T00:20:00.000200Z"
    const result = countEventsOutputSchema.parse(
      (
        await ok("count_events", {
          dataset: "otel_replay",
          group_by: ["level"],
          from,
          to,
        })
      ).data
    )
    const expected = await oracle.query<{ n: string }>(
      `SELECT count(*)::VARCHAR AS n FROM otlp.otel_logs WHERE ${marked} AND "timestamp" >= $1::TIMESTAMP_NS AND "timestamp" < $2::TIMESTAMP_NS`,
      [from, to]
    )
    expect(result.total).toBe(Number(expected.rows[0]?.n))
  })

  it("returns same-trace context with original event IDs, record times and receipt source", async () => {
    const { rows } = await oracle.query<{ trace: string; fixture_row: string }>(
      `SELECT trace_id AS trace, (log_attributes ->> 'log_insights.fixture_row') AS fixture_row FROM otlp.otel_logs WHERE ${marked} AND trace_id IS NOT NULL ORDER BY "timestamp", (log_attributes ->> 'log_insights.fixture_row')::BIGINT LIMIT 1`
    )
    const anchor = rows[0]
    if (anchor === undefined) throw new Error("no replay record with trace")
    const result = await ok("get_log_context", {
      mode: "event",
      event_id: 2_000_000_000_000 + Number(anchor.fixture_row),
      scope: "same_trace",
    })
    const context = eventContextOutputSchema.parse(result.data)
    expect(context.anchor).toMatchObject({
      dataset: "otel_replay",
      trace_id: anchor.trace,
    })
    expect(context.scope_value).toBe(anchor.trace)
    // This one-millisecond fixture has one record per non-empty trace.
    expect(context.events_before).toEqual([])
    expect(context.events_after).toEqual([])
    for (const event of [...context.events_before, ...context.events_after])
      expect(event.trace_id).toBe(anchor.trace)
    expect(result.receipt.source?.kind).toBe("otlp_replay")
    const component = eventContextOutputSchema.parse(
      (
        await ok("get_log_context", {
          mode: "event",
          event_id: context.anchor.event_id,
          scope: "same_component",
        })
      ).data
    )
    expect(
      component.events_before.length + component.events_after.length
    ).toBeGreaterThan(0)
    for (const event of [
      ...component.events_before,
      ...component.events_after,
    ]) {
      expect(event.component).toBe(context.anchor.component)
      expect(event.ts).toMatch(/\.\d{6}Z$/)
    }
  })

  it("rejects unsupported pattern, precursor and latency operations with hints", async () => {
    for (const [tool, input] of [
      ["recurring_patterns", { dataset: "otel_replay" }],
      [
        "get_log_context",
        { mode: "aggregate", dataset: "otel_replay", query: "called" },
      ],
      ["latency_stats", { dataset: "otel_replay" }],
      [
        "event_trend",
        { dataset: "otel_replay", bucket: "second", split_by: "pattern" },
      ],
    ] as const) {
      const outcome = await registry.runTool(tool, input, {
        client: "test",
        signal: new AbortController().signal,
      })
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: "invalid_input", hint: expect.any(String) },
      })
    }
  })
})
