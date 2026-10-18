/**
 * LOG-31 characterization captured before the SQL migration on the Loghub
 * 2k samples. Only the per-run receipt prefix of each fact ID is removed;
 * data, fact order/metadata and result digests are compared unchanged.
 *
 * The domain functions below are independent test oracles. They consume
 * the same returned count pairs or an independently queried sparse series,
 * and must never become the runtime implementation of these SQL rules.
 */
import { createHash } from "node:crypto"
import { readFile, rm } from "node:fs/promises"

import { canonicalJson } from "@workspace/domain/receipt"
import {
  classifyChange,
  comparisonCoverage,
} from "@workspace/domain/rules/compare"
import { bucketGrid, fillBuckets, type TimeRange } from "@workspace/domain/time"
import { countEventsOutputSchema } from "@workspace/domain/tools/count-events"
import { eventTrendOutputSchema } from "@workspace/domain/tools/event-trend"
import { CONTRACT_VERSION } from "@workspace/domain/version"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { comparisonCoverageSql } from "../../src/comparison.ts"
import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore, resultDigest } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import { exactCount, isoTime } from "../../src/sql.ts"
import { describeCorpus } from "../../src/tools/describe-corpus.ts"
import { loadEnv, samplesConnection, temporaryDir } from "./helpers.ts"

loadEnv()

const loadReferenceSchema = z.object({
  image: z.string(),
  data_version: z.string(),
  describe_result_digest: z.string(),
})

const baselineSchema = z.object({
  source: z.string(),
  data_version: z.string(),
  loads: z.array(loadReferenceSchema),
  describe_result: describeCorpus.output,
  cases: z.array(
    z.object({
      name: z.string(),
      tool: z.string(),
      input: z.record(z.string(), z.unknown()),
      normalized_facts_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      result_digest: z.string(),
    })
  ),
})

// Compact hashes preserve every value and array order. Facts are hashed
// after stripping only their random receipt prefix (f1, f2, … remain).
const baselineText = await readFile(
  new URL("./fixtures/sql-rule-baseline.json", import.meta.url),
  "utf8"
)
const baseline = baselineSchema.parse(JSON.parse(baselineText))

let db: Database
let registry: Registry
let receiptsDir: string
let expectedLoad: z.infer<typeof loadReferenceSchema>

beforeAll(async () => {
  db = createDatabase(samplesConnection())
  const loaded = await db.query(
    "SELECT image, data_version FROM load_manifest",
    [],
    call().signal
  )
  const manifest = z
    .object({ image: z.string(), data_version: z.string() })
    .parse(loaded.rows[0])
  // Image identity is part of data_version. Pin both approved 26.10.1
  // builds rather than treating their distinct load manifests as identical.
  expectedLoad = loadReferenceSchema.parse(
    baseline.loads.find((reference) => reference.image === manifest.image)
  )
  z.literal(expectedLoad.data_version).parse(manifest.data_version)
  // Keep the original complete capture and its historical digest pinned.
  // Only the two contextual version stamps vary for current invocations.
  z.literal(expectedLoad.describe_result_digest).parse(
    resultDigest(
      describeReference(baseline.describe_result.versions.contract_version)
    )
  )
  receiptsDir = await temporaryDir("analytics-sql-rule-parity-")
  registry = createRegistry({
    db,
    receipts: new FileReceiptStore(receiptsDir),
    log: () => undefined,
  })
})

afterAll(async () => {
  await db.dispose()
  await rm(receiptsDir, { recursive: true, force: true })
})

const call = () => ({
  client: "test" as const,
  signal: new AbortController().signal,
})

function describeReference(contractVersion: string) {
  return {
    ...baseline.describe_result,
    versions: {
      ...baseline.describe_result.versions,
      data_version: expectedLoad.data_version,
      contract_version: contractVersion,
    },
  }
}

async function run(tool: string, input: Record<string, unknown>) {
  const outcome = await registry.runTool(tool, input, call())
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.result
}

function checkChange(
  current: number,
  row: {
    baseline?: number | null | undefined
    delta?: number | null | undefined
    pct_change?: number | null | undefined
    classification?: string | null | undefined
  }
): void {
  if (row.baseline === undefined) throw new Error("missing comparison count")
  const expected =
    row.baseline === null
      ? { delta: null, pct_change: null, label: null }
      : classifyChange(current, row.baseline)
  expect(row.delta).toBe(expected.delta)
  expect(row.pct_change === null).toBe(expected.pct_change === null)
  expect(row.pct_change ?? 0).toBeCloseTo(expected.pct_change ?? 0, 12)
  expect("classification" in row ? row.classification : undefined).toBe(
    "classification" in row ? expected.label : undefined
  )
}

describe("pre-migration result, fact and digest parity", () => {
  it.each(baseline.cases)("$name", async (fixture) => {
    const result = await run(fixture.tool, fixture.input)
    const expectedDigest =
      fixture.tool === "describe_corpus"
        ? resultDigest(describeReference(CONTRACT_VERSION))
        : fixture.result_digest
    const normalizedFacts = result.facts.map((fact) => ({
      ...fact,
      id: fact.id.replace(/^r_[0-9a-f]+\./, ""),
    }))
    expect(
      createHash("sha256").update(canonicalJson(normalizedFacts)).digest("hex")
    ).toBe(fixture.normalized_facts_sha256)
    expect(resultDigest(result.data)).toBe(expectedDigest)
    expect(result.receipt.result_digest).toBe(expectedDigest)
    expect(result.receipt.data_version).toBe(expectedLoad.data_version)

    if (fixture.tool === "count_events") {
      const data = countEventsOutputSchema.parse(result.data)
      if (data.comparison !== null) {
        checkChange(data.total, data.comparison)
        data.groups.forEach((group) => checkChange(group.events, group))
        if (data.other !== null) checkChange(data.other.events, data.other)
      }
    }
  })
})

const SPAN = {
  first: "2017-05-16T00:00:00.000001Z",
  last: "2017-05-16T00:10:00.000001Z",
}
const ranges: { name: string; range: TimeRange }[] = [
  {
    name: "full including the last microsecond",
    range: { from: SPAN.first, to: "2017-05-16T00:10:00.000002Z" },
  },
  {
    name: "partial at the start",
    range: { from: "2017-05-16T00:00:00Z", to: "2017-05-16T00:05:00Z" },
  },
  {
    name: "partial at the end",
    range: {
      from: "2017-05-16T00:05:00Z",
      to: "2017-05-16T00:10:00.000003Z",
    },
  },
  {
    name: "none ending on the first instant",
    range: { from: "2017-05-15T23:59:00Z", to: SPAN.first },
  },
  {
    name: "none starting after the last microsecond",
    range: {
      from: "2017-05-16T00:10:00.000002Z",
      to: "2017-05-16T00:11:00Z",
    },
  },
  {
    name: "one observed last microsecond",
    range: { from: SPAN.last, to: "2017-05-16T00:10:00.000002Z" },
  },
  {
    name: "equivalent offset timestamps",
    range: {
      from: "2017-05-15T17:00:00.000001-07:00",
      to: "2017-05-15T17:10:00.000002-07:00",
    },
  },
]

describe("SQL comparison coverage against the R-03/R-06 oracle", () => {
  for (const current of ranges) {
    it.each(ranges)(
      `${current.name}, baseline $name`,
      async (baselineRange) => {
        const actual = await comparisonCoverageSql(
          { db, signal: call().signal },
          current.range,
          baselineRange.range,
          SPAN
        )
        expect(actual).toEqual(
          comparisonCoverage(current.range, baselineRange.range, SPAN)
        )
      }
    )
  }
})

const trendCases = [
  {
    name: "hour boundaries and microseconds",
    dataset: "bgl",
    bucket: "hour",
    from: "2005-06-03T22:42:53.276129Z",
    to: "2005-06-04T02:00:00Z",
  },
  {
    name: "day grid with capture gaps",
    dataset: "bgl",
    bucket: "day",
    from: "2005-06-01T00:00:00-07:00",
    to: "2005-06-15T00:00:00-07:00",
  },
  {
    name: "Monday week boundaries",
    dataset: "bgl",
    bucket: "week",
    from: "2005-06-01T00:00:00Z",
    to: "2005-07-01T00:00:00Z",
  },
  {
    name: "empty filtered counts inside an observed span",
    dataset: "bgl",
    bucket: "day",
    from: "2005-06-03T00:00:00Z",
    to: "2005-06-15T00:00:00Z",
    levels: ["ABSENT_LEVEL"],
  },
  {
    name: "one partial hour",
    dataset: "openstack",
    bucket: "hour",
    from: "2017-05-16T00:00:00Z",
    to: "2017-05-16T01:00:00Z",
  },
] as const

const sparseRow = z.object({
  bucket: z.string(),
  events: exactCount,
})

describe("SQL bucket grid and zero fill against the domain oracle", () => {
  it.each(trendCases)("$name", async ({ name, ...input }) => {
    const result = await run("event_trend", input)
    const data = eventTrendOutputSchema.parse(result.data)
    const effective = data.effective_range
    if (effective === null)
      throw new Error(`${name}: expected an observed data span`)
    const grid = bucketGrid(effective, input.bucket)
    expect(
      data.buckets.map((bucket) => ({
        start: bucket.bucket_start,
        end: bucket.bucket_end,
        partial: bucket.partial,
      }))
    ).toEqual(grid)

    // This independent sparse aggregate has no generated grid or SQL rule
    // flags. The oracle supplies them from the same observed SQL rows.
    const params = [input.dataset, effective.from, effective.to]
    const level = "levels" in input ? " AND level = $4" : ""
    if ("levels" in input) params.push(input.levels[0])
    const truncate = `date_trunc('${input.bucket}', ts)`
    const sparse = await db.query(
      `SELECT ${isoTime(truncate)} AS bucket, count(*) AS events FROM log_events WHERE dataset = $1 AND ts >= $2::TIMESTAMPTZ AND ts < $3::TIMESTAMPTZ${level} GROUP BY 1 ORDER BY 1`,
      params,
      call().signal
    )
    const expectedCounts = fillBuckets(
      sparse.rows.map((row) => sparseRow.parse(row)),
      grid.map((slot) => slot.start),
      (bucket) => ({ bucket, events: 0 })
    )
    expect(data.buckets.map((bucket) => bucket.events)).toEqual(
      expectedCounts.map((bucket) => bucket.events)
    )

    const capture = await db.query(
      `SELECT ${isoTime(truncate)} AS bucket, count(*) AS events FROM log_events WHERE dataset = $1 AND ts >= $2::TIMESTAMPTZ AND ts < $3::TIMESTAMPTZ GROUP BY 1 ORDER BY 1`,
      params.slice(0, 3),
      call().signal
    )
    const observed = new Set(
      capture.rows.map((row) => sparseRow.parse(row).bucket)
    )
    expect(data.buckets.map((bucket) => bucket.capture_gap)).toEqual(
      grid.map((slot) => !observed.has(slot.start))
    )
  })
})
