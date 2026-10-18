/** Independent LOG-35 Golden SQL from design D1/D3/D4/D8 and the catalog. */
import { countEventsOutputSchema } from "@workspace/domain/tools/count-events"
import { eventTrendOutputSchema } from "@workspace/domain/tools/event-trend"
import { searchLogsOutputSchema } from "@workspace/domain/tools/search-logs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import {
  createGoldenHarness,
  expectClose,
  integer,
  type GoldenHarness,
} from "./helpers.ts"
import {
  otelReferenceSql,
  otelReferenceWindow,
  otelUrls,
  type OtelWindow,
} from "./otel-reference.ts"

/**
 * Read-only against the loaded full corpus: no fixture fallback, download,
 * materialization or data setup. The oracle reads the real allowlisted HTTPS
 * objects, never the indexed view, otel_sources or tool-generated SQL. The
 * existing Golden harness invokes the registry only for the actual result.
 */
let golden: GoldenHarness
beforeAll(async () => {
  golden = await createGoldenHarness()
})
afterAll(async () => {
  await golden?.close()
})

const countSchema = z.object({ events: integer })
const levelSchema = z.object({
  level: z.string(),
  events: integer,
  share: z.coerce.number(),
  total: integer,
})

const windows = [
  {
    name: "one second of part_000 outside the index",
    from: "2025-09-23T00:20:00.000000Z",
    to: "2025-09-23T00:20:01.000000Z",
    files: [0],
  },
  {
    name: "ten seconds of part_001 outside the index",
    from: "2025-09-23T00:29:34.000000Z",
    to: "2025-09-23T00:29:44.000000Z",
    files: [1],
  },
  {
    name: "one second crossing the part_000/001 boundary",
    from: "2025-09-23T00:29:24.000000Z",
    to: "2025-09-23T00:29:25.000000Z",
    files: [0, 1],
  },
  {
    name: "ten seconds crossing the part_000/001 boundary",
    from: "2025-09-23T00:29:19.000000Z",
    to: "2025-09-23T00:29:29.000000Z",
    files: [0, 1],
  },
] as const satisfies readonly (OtelWindow & { name: string })[]

describe("otel independent HTTPS counts and UTC trends", () => {
  for (const window of windows) {
    it(`${window.name}: exact level groups, shares and source files`, async () => {
      const reference = otelReferenceSql(window)
      const expected = await golden.sql(
        `${reference.cte}, grouped AS (
          SELECT level, count(*) AS events FROM source GROUP BY level
        ) SELECT level, events, events::DOUBLE / sum(events) OVER () AS share,
          sum(events) OVER () AS total FROM grouped
        ORDER BY events DESC, level`,
        reference.params,
        levelSchema
      )
      const first = expected[0]
      if (!first)
        throw new Error("The real HTTPS window unexpectedly has no rows")
      const result = await golden.run(
        "count_events",
        {
          dataset: "otel",
          from: window.from,
          to: window.to,
          group_by: ["level"],
          top_n: 50,
        },
        countEventsOutputSchema
      )
      expect(result.data.total).toBe(first.total)
      expect(result.data.group_count).toBe(expected.length)
      expect(result.data.groups).toHaveLength(expected.length)
      for (const [index, row] of expected.entries()) {
        const actual = result.data.groups[index]
        expect(actual).toMatchObject({ level: row.level, events: row.events })
        expectClose(actual?.share ?? null, row.share)
      }
      // These are different logged levels; neither can be normalized to the other.
      expect(expected.map((row) => row.level)).toEqual(
        expect.arrayContaining(["info", "information"])
      )
      expect(result.data.other).toBeNull()
      expect(result.data.truncated).toBe(false)
      expect(result.data.unit).toBe("log_events")
      const source = result.receipt.source
      if (source?.kind !== "remote_parquet")
        throw new Error("Missing remote Parquet provenance")
      expect(source.path).toBe("direct_scan")
      expect(source.files.map((file) => file.url)).toEqual(
        window.files.map((file) => otelUrls[file])
      )
      expect(source.source_check.files_checked).toBe(window.files.length)
      expect(source.bytes_read.kind).toBe("not_measured")
      expect(source.index).toBeNull()
      expect(
        await golden.receipts.get(result.receipt.receipt_id)
      ).toMatchObject({
        result: result.data,
        source,
      })
    })
  }

  it("ten-second UTC buckets count errors independently, including zero buckets", async () => {
    const window = windows[3]
    const reference = otelReferenceSql(window)
    // The native date_trunc overload rounds ns to microseconds first (26.10.1,
    // probe 2026-10-18). Floor integer epoch ns before formatting the grid so
    // an event at xx:xx:28.999999803 stays in second 28, not second 29.
    const expected = await golden.sql(
      `${reference.cte}, clocked AS (
        SELECT make_timestamp_ns((epoch_ns(ts) // 1000000000::BIGINT) * 1000000000::BIGINT) AS start,
          level FROM source
      ), buckets AS (
        SELECT start, count(*) AS captured,
          sum(CASE WHEN level IN ('error', 'fatal') THEN 1 ELSE 0 END) AS events
        FROM clocked GROUP BY start
      ) SELECT strftime(start, '%Y-%m-%dT%H:%M:%S.%fZ') AS bucket_start,
        strftime(start + INTERVAL '1 SECOND', '%Y-%m-%dT%H:%M:%S.%fZ') AS bucket_end,
        captured, events, sum(events) OVER () AS total
      FROM buckets ORDER BY start`,
      reference.params,
      z.object({
        bucket_start: z.string(),
        bucket_end: z.string(),
        captured: integer,
        events: integer,
        total: integer,
      })
    )
    expect(expected).toHaveLength(10)
    const result = await golden.run(
      "event_trend",
      {
        dataset: "otel",
        from: window.from,
        to: window.to,
        bucket: "second",
        only_errors: true,
      },
      eventTrendOutputSchema
    )
    expect(result.data.total).toBe(expected[0]?.total)
    expect(result.data.bucket_count).toBe(10)
    expect(result.data.buckets).toEqual(
      expected.map((row) => ({
        bucket_start: row.bucket_start,
        bucket_end: row.bucket_end,
        partial: false,
        capture_gap: row.captured === 0,
        events: row.events,
        series: [],
        other_events: null,
      }))
    )
    expect(result.data.effective_range).toEqual({
      from: window.from,
      to: window.to,
    })
  })

  it("the shared nanosecond boundary belongs to part_001 exactly once", async () => {
    const window = windows[2]
    const raw = otelReferenceSql(window, false)
    const [boundary] = await golden.sql(
      `${raw.cte} SELECT count(*) AS raw_events,
        sum(CASE WHEN file_index = 0 AND ts >= $3::TIMESTAMPTZ_NS THEN 1 ELSE 0 END) AS excluded,
        sum(CASE WHEN file_index = 0 AND ts >= $3::TIMESTAMPTZ_NS THEN 0 ELSE 1 END) AS assigned_events,
        sum(CASE WHEN file_index = 1 AND ts = $3::TIMESTAMPTZ_NS THEN 1 ELSE 0 END) AS boundary_rows
      FROM source`,
      raw.params,
      z.object({
        raw_events: integer,
        excluded: integer,
        assigned_events: integer,
        boundary_rows: integer,
      })
    )
    if (!boundary) throw new Error("Missing boundary aggregate")
    expect(boundary.excluded).toBeGreaterThan(0)
    expect(boundary.boundary_rows).toBeGreaterThan(0)
    expect(boundary.raw_events).toBeGreaterThan(boundary.assigned_events)
    const result = await golden.run(
      "count_events",
      {
        dataset: "otel",
        from: window.from,
        to: window.to,
        group_by: ["dataset"],
      },
      countEventsOutputSchema
    )
    expect(result.data.total).toBe(boundary.assigned_events)

    // The real boundary is .039037200, not .039037000: the first [from,to)
    // excludes it, the adjacent microsecond window includes it. A rounded
    // TIMESTAMPTZ predicate on the ns column would put the row on the wrong side.
    for (const edge of [
      {
        from: "2025-09-23T00:29:24.039036Z",
        to: "2025-09-23T00:29:24.039037Z",
        files: [0],
      },
      {
        from: "2025-09-23T00:29:24.039037Z",
        to: "2025-09-23T00:29:24.039038Z",
        files: [0, 1],
      },
    ] as const) {
      const reference = otelReferenceSql(edge)
      const [expected] = await golden.sql(
        `${reference.cte} SELECT count(*) AS events FROM source`,
        reference.params,
        countSchema
      )
      const actual = await golden.run(
        "count_events",
        {
          dataset: "otel",
          from: edge.from,
          to: edge.to,
          group_by: ["dataset"],
        },
        countEventsOutputSchema
      )
      expect(actual.data.total).toBe(expected?.events)
    }
  })
})

const searchCases = [
  {
    name: "whole-token terms",
    query: "called",
    match: "terms",
    predicate: "regexp_matches(lower(message), '\\bcalled\\b')",
  },
  {
    name: "adjacent-token phrase",
    query: "called with",
    match: "phrase",
    predicate:
      "contains(' ' || regexp_replace(lower(message), '[^a-z0-9]+', ' ', 'g') || ' ', ' called with ')",
  },
  {
    name: "unobserved token",
    query: "goldenunobservedtokenzzzz",
    match: "terms",
    predicate:
      "regexp_matches(lower(message), '\\bgoldenunobservedtokenzzzz\\b')",
  },
] as const

const hitSchema = z.object({
  event_id: integer,
  component: z.string(),
  level: z.string(),
  trace_id: z.string(),
  span_id: z.string(),
  severity_number: integer,
  message: z.string(),
  message_truncated: z.boolean(),
})

describe("otel indexed full text against independent HTTPS message scans", () => {
  for (const entry of searchCases) {
    it(`${entry.name}: exact counts, stable IDs and verbatim fields`, async () => {
      const window = windows[2]
      const reference = otelReferenceSql(window)
      // Scalar regexes over the raw body are deliberately independent of @@,
      // the index, the relation router and the tool's full-text compiler.
      const [expected] = await golden.sql(
        `${reference.cte} SELECT count(*) AS events FROM source WHERE ${entry.predicate}`,
        reference.params,
        countSchema
      )
      const hits = await golden.sql(
        `${reference.cte} SELECT
          (1000000000000::BIGINT + file_index::BIGINT * 10000000000::BIGINT + file_row_number)::BIGINT AS event_id,
          component, level, trace_id, span_id, severity_number,
          substring(message, 1, 400) AS message, length(message) > 400 AS message_truncated
        FROM source WHERE ${entry.predicate}
        ORDER BY ts, event_id LIMIT 50`,
        reference.params,
        hitSchema
      )
      const result = await golden.run(
        "search_logs",
        {
          dataset: "otel",
          from: window.from,
          to: window.to,
          query: entry.query,
          match: entry.match,
          sort: "time_asc",
          limit: 50,
        },
        searchLogsOutputSchema
      )
      expect(result.data.total_matches).toBe(expected?.events)
      expect(result.data.hits.map((hit) => hitSchema.parse(hit))).toEqual(hits)
      expect(result.data.truncated).toBe(
        result.data.total_matches !== null && result.data.total_matches > 50
      )
      const source = result.receipt.source
      if (source?.kind !== "remote_parquet")
        throw new Error("Missing remote Parquet provenance")
      expect(source.path).toBe("indexed_window")
      expect(source.files.map((file) => file.url)).toEqual([...otelUrls])
      expect(source.index).toMatchObject(otelReferenceWindow)
      expect(source.bytes_read.kind).toBe("not_measured")
    })
  }

  for (const entry of searchCases.filter((item) => item.match === "terms")) {
    it(`${entry.name}: aggregation text filter matches the raw HTTPS count`, async () => {
      const window = windows[2]
      const reference = otelReferenceSql(window)
      const [expected] = await golden.sql(
        `${reference.cte} SELECT count(*) AS events FROM source WHERE ${entry.predicate}`,
        reference.params,
        countSchema
      )
      const counted = await golden.run(
        "count_events",
        {
          dataset: "otel",
          from: window.from,
          to: window.to,
          text: entry.query,
          group_by: ["dataset"],
        },
        countEventsOutputSchema
      )
      expect(counted.data.total).toBe(expected?.events)
    })
  }

  it("a repeated called search keeps the result digest on the same data version", async () => {
    const window = windows[2]
    const result = await golden.run(
      "search_logs",
      {
        dataset: "otel",
        from: window.from,
        to: window.to,
        query: "called",
        sort: "time_asc",
        limit: 50,
      },
      searchLogsOutputSchema
    )
    expect(result.data.total_matches).toBeGreaterThan(50)
    const repeated = await golden.run(
      "search_logs",
      result.receipt.input,
      searchLogsOutputSchema
    )
    expect(repeated.receipt.result_digest).toBe(result.receipt.result_digest)
  })
})
