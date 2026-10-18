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
  firstOutput = await runSetupCli(["--samples", "--with", "otel"], "UTC")
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

  it("is idempotent: a second run copies nothing and keeps the data version", async () => {
    const second = await runSetupCli(["--samples", "--with", "otel"], "UTC")
    expect(second).toContain("present  otel/part_000.parquet")
    expect(dataVersionOf(second)).toBe(dataVersionOf(firstOutput))
  })
})
