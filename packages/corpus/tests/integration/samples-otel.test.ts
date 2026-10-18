/**
 * `pnpm data:setup --samples --with otel` against SereneDB (LOG-35): the base
 * 2k samples plus the two committed otel Parquet fixtures, copied to
 * .data/raw/otel/ and read through local paths (hermetic CI), into the
 * separate database `log_insights_samples_otel`.
 *
 * Expected values come from the catalog (fixture sizes and digests) or from
 * independent read_parquet queries written here, never from the loader SQL.
 */
import type { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { DATASETS } from "@workspace/domain/datasets"

import {
  closeIfOpen,
  connectTo,
  dataVersionOf,
  loadEnv,
  rows,
  runSetupCli,
} from "./helpers.ts"

loadEnv()

const DATABASE = "log_insights_samples_otel"
const FIXTURES = DATASETS.otel.remote.samples.files

let client: Client
let firstOutput = ""

beforeAll(async () => {
  firstOutput = await runSetupCli(
    ["--samples", "--with", "otel,otel_replay"],
    "UTC"
  )
  client = await connectTo(DATABASE)
})

afterAll(async () => {
  await closeIfOpen(client)
})

describe("otel samples load", () => {
  it("passes every load check, including the otel checks 30–34", async () => {
    const checks = await rows(
      client,
      "SELECT check_name, ok FROM load_checks ORDER BY check_name"
    )
    expect(checks.filter((check) => check["ok"] !== true)).toEqual([])
    const names = checks.map((check) => String(check["check_name"]))
    for (const prefix of [
      "otel: per file footer rows",
      "otel: files ascend in time",
      "otel: reference index count = view count = direct per-file scan",
      "otel: boundary rows removed by the half-open rule",
      "otel: full-text index @@ 'called'",
    ])
      expect(names.some((name) => name.startsWith(prefix))).toBe(true)
  })

  it("pins both fixtures with their catalog size and reads their footers", async () => {
    const sources = await rows(
      client,
      `SELECT file_index, url, size::VARCHAR AS size, etag, footer_rows::VARCHAR AS footer_rows,
         strftime(assigned_from, '%Y-%m-%dT%H:%M:%S.%nZ') AS assigned_from,
         strftime(assigned_to, '%Y-%m-%dT%H:%M:%S.%nZ') AS assigned_to
       FROM otel_sources ORDER BY file_index`
    )
    const counted = await rows(
      client,
      `SELECT regexp_extract(filename, 'part_([0-9]{3})', 1)::INTEGER AS file_index, count(*)::VARCHAR AS n,
         strftime(min("Timestamp"), '%Y-%m-%dT%H:%M:%S.%nZ') AS first
       FROM read_parquet('/data/raw/otel/part_00[0-1].parquet', filename = true)
       GROUP BY 1 ORDER BY 1`
    )
    expect(sources).toEqual(
      FIXTURES.map((fixture, index) => ({
        file_index: fixture.index,
        url: `/data/raw/${fixture.path}`,
        size: String(fixture.bytes),
        etag: null,
        footer_rows: counted[index]?.["n"],
        assigned_from: counted[index]?.["first"],
        // Half-open: a file answers up to the next file's first row.
        assigned_to: counted[index + 1]?.["first"] ?? null,
      }))
    )
  })

  it("keeps otel out of log_events and leaves its patterns and line counts NULL", async () => {
    expect(
      await rows(
        client,
        "SELECT count(*)::VARCHAR AS n FROM log_events WHERE dataset = 'otel'"
      )
    ).toEqual([{ n: "0" }])
    const [stats] = await rows(
      client,
      "SELECT events, lines_read, rejected, patterns, single_event_patterns FROM corpus_stats WHERE dataset = 'otel'"
    )
    expect(stats).toEqual({
      events: null,
      lines_read: null,
      rejected: null,
      patterns: null,
      single_event_patterns: null,
    })
  })

  it("indexes the reference window once per boundary row", async () => {
    const [reference] = await rows(
      client,
      "SELECT events::VARCHAR AS events, duplicates_removed::VARCHAR AS duplicates FROM otel_reference"
    )
    const [naive] = await rows(
      client,
      "SELECT count(*)::VARCHAR AS n FROM read_parquet('/data/raw/otel/part_00[0-1].parquet')"
    )
    // The fixtures repeat exactly the boundary row of the bucket.
    expect(reference).toEqual({
      events: String(Number(naive?.["n"]) - 1),
      duplicates: "1",
    })
  })

  it("records the pins, reference window and index build in the manifest", async () => {
    const [manifest] = await rows(
      client,
      "SELECT external_sources::VARCHAR AS external FROM load_manifest"
    )
    const external = JSON.parse(String(manifest?.["external"])) as {
      dataset: string
      kind: string
      mapping_version: string
      reference: { glob: string; from: string; to: string }
      files: { location: string; sha256: string | null }[]
      index: { index_name: string; build_ms: number | null }
    }[]
    expect(external).toHaveLength(1)
    expect(external[0]).toMatchObject({
      dataset: "otel",
      kind: "fixture",
      mapping_version: "1.0.0",
      reference: {
        glob: "/data/raw/otel/part_00[0-1].parquet",
        from: DATASETS.otel.remote.samples.from,
        to: DATASETS.otel.remote.samples.to,
      },
      index: { index_name: "otel_ref_idx" },
    })
    expect(external[0]?.files.map((file) => file.sha256)).toEqual(
      FIXTURES.map((fixture) => fixture.sha256)
    )
    expect(external[0]?.index.build_ms).toBeGreaterThanOrEqual(0)
  })

  it("keeps the replay count, original ns times and load-time observed timestamps", async () => {
    const [stored] = await rows(
      client,
      `SELECT count(*)::VARCHAR AS records, count(DISTINCT event_id)::VARCHAR AS ids,
         min(epoch_ns(ts))::VARCHAR AS first_ns, max(epoch_ns(ts))::VARCHAR AS last_ns,
         count(DISTINCT observed_ts)::VARCHAR AS observed_times,
         bool_and(observed_ts = (SELECT replayed_at FROM otel_replay)) AS observed_is_replay
       FROM otel_replay_events`
    )
    expect(stored).toEqual({
      records: "365",
      ids: "365",
      first_ns: "1758586800000000000",
      last_ns: "1758586800000997454",
      observed_times: "1",
      observed_is_replay: true,
    })
    expect(
      await rows(
        client,
        "SELECT count(*)::VARCHAR AS n FROM log_events WHERE dataset = 'otel_replay'"
      )
    ).toEqual([{ n: "0" }])
    const [manifest] = await rows(
      client,
      "SELECT otlp_replay::VARCHAR AS replay FROM load_manifest"
    )
    expect(JSON.parse(String(manifest?.["replay"]))).toMatchObject({
      dataset: "otel_replay",
      fixture: {
        records: 365,
        sha256: DATASETS.otel_replay.replay.fixture.sha256,
      },
      listener: { database: DATABASE, table: "otlp.otel_logs" },
    })
  })

  it("stores duplicate POSTs twice; a rerun clears them and replaces the replay without accumulating rows", async () => {
    // An isolated regression export, sent byte-for-byte twice. It carries
    // the repo replay marker so the following load must clear it as well.
    const body = JSON.stringify({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1758586800000000001",
                  body: { stringValue: "duplicate export regression" },
                  attributes: [
                    {
                      key: "log_insights.replay_id",
                      value: { stringValue: "log35_duplicate_regression" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
    const port = process.env["SERENEDB_OTLP_SAMPLES_PORT"]
    if (port === undefined)
      throw new Error("SERENEDB_OTLP_SAMPLES_PORT is required")
    const auth = Buffer.from(
      `${process.env["SERENEDB_USER"]}:${process.env["SERENEDB_PASSWORD"]}`
    ).toString("base64")
    let second = ""
    try {
      for (let post = 0; post < 2; post++) {
        const response = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            authorization: `Basic ${auth}`,
          },
          signal: AbortSignal.timeout(10_000),
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({})
      }
      await client.query("VACUUM (REFRESH_TABLE) otlp.otel_logs")
      expect(
        await rows(
          client,
          `SELECT count(*)::VARCHAR AS n FROM otlp.otel_logs WHERE log_attributes ->> 'log_insights.replay_id' = 'log35_duplicate_regression'`
        )
      ).toEqual([{ n: "2" }])
      // Tools read the built index snapshot, not arbitrary later exports.
      expect(
        await rows(client, "SELECT count(*)::VARCHAR AS n FROM otel_replay_idx")
      ).toEqual([{ n: "365" }])
    } finally {
      // Leave the database ready for the registry tests even after a failed
      // assertion; the loader deletes all rows with a replay marker.
      second = await runSetupCli(
        ["--samples", "--with", "otel,otel_replay"],
        "America/Los_Angeles"
      )
    }
    expect(second).toContain("present  otel/part_000.parquet")
    // Each rerun records its new observed time and replay ID in the version.
    expect(dataVersionOf(second)).not.toBe(dataVersionOf(firstOutput))
    expect(
      await rows(
        client,
        "SELECT count(*)::VARCHAR AS n FROM otlp.otel_logs WHERE log_attributes ->> 'log_insights.replay_id' IS NOT NULL"
      )
    ).toEqual([{ n: "365" }])
    expect(
      await rows(
        client,
        "SELECT count(*)::VARCHAR AS n FROM otel_replay_events"
      )
    ).toEqual([{ n: "365" }])
    expect(
      (await rows(client, "SELECT ok FROM load_checks")).every(
        (check) => check["ok"] === true
      )
    ).toBe(true)
  })

  it("versions a changed reference index snapshot even when remote-only source pins are equal", async () => {
    try {
      const first = await runSetupCli(["--samples", "--with", "otel"], "UTC")
      const [before] = await rows(
        client,
        "SELECT built_at::VARCHAR AS built_at FROM otel_reference"
      )
      const second = await runSetupCli(["--samples", "--with", "otel"], "UTC")
      const [after] = await rows(
        client,
        "SELECT built_at::VARCHAR AS built_at FROM otel_reference"
      )
      expect(after?.["built_at"]).not.toBe(before?.["built_at"])
      expect(dataVersionOf(second)).not.toBe(dataVersionOf(first))
    } finally {
      await runSetupCli(["--samples", "--with", "otel,otel_replay"], "UTC")
    }
  })
})
