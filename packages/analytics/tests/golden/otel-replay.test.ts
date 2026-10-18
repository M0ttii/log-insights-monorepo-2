/** Independent LOG-35 replay verification from design D7/D8 and public contracts. */
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

import { DATASETS } from "@workspace/domain/datasets"
import { countEventsOutputSchema } from "@workspace/domain/tools/count-events"
import { searchLogsOutputSchema } from "@workspace/domain/tools/search-logs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import {
  createGoldenHarness,
  expectClose,
  integer,
  type GoldenHarness,
} from "./helpers.ts"
import { otelUrls } from "./otel-reference.ts"

/**
 * The reference relation is SereneDB's listener table, not the tool's replay
 * view. No replay, source-loading or analytics implementation is imported.
 * These tests never POST, clear, refresh or resend records; the coordinating
 * full-corpus load must already have replayed the committed fixture once.
 * Context7 /serenedb/serenedb (2026-10-18) documents otel_logs, TIMESTAMP_NS,
 * observed_timestamp, promoted service/severity fields and log_attributes.
 */
let golden: GoldenHarness
beforeAll(async () => {
  golden = await createGoldenHarness()
})
afterAll(async () => {
  await golden?.close()
})

const fixture = DATASETS.otel_replay.replay.fixture
const countSchema = z.object({ events: integer })
const groupSchema = z.object({
  component: z.string().nullable(),
  level: z.string().nullable(),
  events: integer,
  share: z.coerce.number(),
  total: integer,
})
const hitSchema = z.object({
  event_id: integer,
  component: z.string().nullable(),
  level: z.string().nullable(),
  trace_id: z.string().nullable(),
  span_id: z.string().nullable(),
  severity_number: integer.nullable(),
  message: z.string(),
  message_truncated: z.boolean(),
})

describe("otel_replay independent OTLP listener SQL", () => {
  it("the committed provenance and listener contain exactly one bounded replay", async () => {
    const bytes = await readFile(
      new URL(
        "../../../corpus/fixtures/otel-replay/part_000.json",
        import.meta.url
      )
    )
    const provenance = z
      .object({
        source: z.string(),
        selection: z.string(),
        records: z.array(z.unknown()),
      })
      .parse(JSON.parse(bytes.toString("utf8")))
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      fixture.sha256
    )
    expect(bytes.byteLength).toBe(fixture.bytes)
    expect(provenance.source).toBe(otelUrls[0])
    expect(provenance.selection).toBe(fixture.selection)
    expect(provenance.records).toHaveLength(fixture.records)
    const [expected] = await golden.sql(
      `SELECT count(*) AS events,
        sum(CASE WHEN severity_text IN ('error', 'fatal') THEN 1 ELSE 0 END) AS errors,
        count(DISTINCT observed_timestamp) AS observations,
        count(DISTINCT log_attributes ->> 'log_insights.replay_id') AS replays,
        count(DISTINCT log_attributes ->> 'log_insights.fixture_row') AS fixture_rows,
        sum(CASE WHEN "timestamp" < $1::TIMESTAMP_NS OR "timestamp" >= $2::TIMESTAMP_NS
          THEN 1 ELSE 0 END) AS outside_window
      FROM otlp.otel_logs`,
      [fixture.from, fixture.to],
      z.object({
        events: integer,
        errors: integer,
        observations: integer,
        replays: integer,
        fixture_rows: integer,
        outside_window: integer,
      })
    )
    if (!expected) throw new Error("Missing OTLP listener aggregate")
    expect(expected.events).toBe(fixture.records)
    expect(expected.observations).toBe(1)
    expect(expected.replays).toBe(1)
    expect(expected.fixture_rows).toBe(fixture.records)
    expect(expected.outside_window).toBe(0)
    const result = await golden.run(
      "count_events",
      { dataset: "otel_replay", group_by: ["dataset"], only_errors: true },
      countEventsOutputSchema
    )
    expect(result.data.total).toBe(expected.errors)
    const source = result.receipt.source
    if (source?.kind !== "otlp_replay")
      throw new Error("Missing bounded OTLP replay provenance")
    expect(source.records).toBe(expected.events)
    expect(source.listener_table).toBe("otlp.otel_logs")
    expect(source.fixture).toMatchObject({
      path: fixture.path,
      sha256: fixture.sha256,
      source_url: otelUrls[0],
    })
    expect(await golden.receipts.get(result.receipt.receipt_id)).toMatchObject({
      result: result.data,
      source,
    })
  })

  it("service/level combinations and shares match the raw listener, including null semantics", async () => {
    const expected = await golden.sql(
      `WITH grouped AS (
        SELECT service_name AS component, severity_text AS level, count(*) AS events
        FROM otlp.otel_logs GROUP BY service_name, severity_text
      ) SELECT component, level, events, events::DOUBLE / sum(events) OVER () AS share,
        sum(events) OVER () AS total FROM grouped
      ORDER BY events DESC, component ASC NULLS LAST, level ASC NULLS LAST`,
      [],
      groupSchema
    )
    expect(expected.length).toBeGreaterThan(0)
    expect(expected.length).toBeLessThanOrEqual(50)
    const result = await golden.run(
      "count_events",
      { dataset: "otel_replay", group_by: ["component", "level"], top_n: 50 },
      countEventsOutputSchema
    )
    expect(result.data.total).toBe(expected[0]?.total)
    expect(result.data.group_count).toBe(expected.length)
    expect(result.data.groups).toHaveLength(expected.length)
    for (const [index, row] of expected.entries()) {
      const actual = result.data.groups[index]
      expect(actual).toMatchObject({
        component: row.component,
        level: row.level,
        events: row.events,
      })
      expectClose(actual?.share ?? null, row.share)
    }
    expect(result.data.other).toBeNull()
    expect(result.data.truncated).toBe(false)
    expect(result.data.unit).toBe("log_events")
  })

  for (const entry of [
    {
      name: "terms",
      query: "called",
      match: "terms",
      predicate: "regexp_matches(lower(body), '\\bcalled\\b')",
    },
    {
      name: "phrase",
      query: "called with",
      match: "phrase",
      predicate:
        "contains(' ' || regexp_replace(lower(body), '[^a-z0-9]+', ' ', 'g') || ' ', ' called with ')",
    },
    {
      name: "fuzzy transposition",
      query: "caleld",
      match: "fuzzy",
      predicate:
        "EXISTS (SELECT 1 FROM unnest(ts_lexize('log_text', body)) AS tokens(word) WHERE damerau_levenshtein(word, 'caleld') <= 1)",
    },
  ] as const) {
    it(`${entry.name}: count and ordered hits match a scalar listener scan`, async () => {
      const [expected] = await golden.sql(
        `SELECT count(*) AS events FROM otlp.otel_logs WHERE ${entry.predicate}`,
        [],
        countSchema
      )
      const hits = await golden.sql(
        `SELECT
          (2000000000000::BIGINT + (log_attributes ->> 'log_insights.fixture_row')::BIGINT) AS event_id,
          service_name AS component, severity_text AS level, trace_id, span_id, severity_number,
          substring(body, 1, 400) AS message, length(body) > 400 AS message_truncated
        FROM otlp.otel_logs WHERE ${entry.predicate}
        ORDER BY "timestamp", event_id LIMIT 50`,
        [],
        hitSchema
      )
      const result = await golden.run(
        "search_logs",
        {
          dataset: "otel_replay",
          query: entry.query,
          match: entry.match,
          ...(entry.match === "fuzzy" ? { max_edits: 1 } : {}),
          sort: "time_asc",
          limit: 50,
        },
        searchLogsOutputSchema
      )
      expect(result.data.total_matches).toBe(expected?.events)
      expect(result.data.hits.map((hit) => hitSchema.parse(hit))).toEqual(hits)
      expect(result.data.total_matches).toBeGreaterThan(50)
      expect(result.data.truncated).toBe(true)
    })
  }

  it("the aggregation text filter matches the scalar listener token count", async () => {
    const [expected] = await golden.sql(
      "SELECT count(*) AS events FROM otlp.otel_logs WHERE regexp_matches(lower(body), '\\bcalled\\b')",
      [],
      countSchema
    )
    const counted = await golden.run(
      "count_events",
      { dataset: "otel_replay", text: "called", group_by: ["dataset"] },
      countEventsOutputSchema
    )
    expect(counted.data.total).toBe(expected?.events)
  })
})
