/** Index offsets on Unicode and truncated text, with hand-written expectations. */
import { rm } from "node:fs/promises"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import { searchLogs } from "../../src/tools/search-logs.ts"
import { buildFixtureDatabase, fixtureConnection } from "./fixtures.ts"
import { loadEnv, temporaryDir } from "./helpers.ts"

loadEnv()
const DATABASE = "log_insights_search_ranges_fixtures"
const MESSAGE = "Ärger 😀 Cache parity error; cache"
const MARKUP = "<script>cache</script> & <b>parity</b>"
let db: Database
let dir: string
let registry: Registry

beforeAll(async () => {
  await buildFixtureDatabase(
    DATABASE,
    [
      MESSAGE,
      "😀 " + "ä".repeat(397) + " lateword",
      "😀 " + "ä".repeat(395) + " cache",
      "😀 " + "ä".repeat(392) + " cache",
      MARKUP,
      "cache cache cache",
      "😀 cache icache",
    ].map((message, index) => ({
      event_id: index + 1,
      dataset: "bgl",
      ts: "2005-06-03T22:00:00.000000Z",
      level: "INFO",
      component: "KERNEL",
      message,
    }))
  )
  db = createDatabase(fixtureConnection(DATABASE))
  dir = await temporaryDir("analytics-search-ranges-")
  registry = createRegistry({
    db,
    receipts: new FileReceiptStore(dir),
    log: () => undefined,
  })
})

afterAll(async () => {
  await db.dispose()
  await rm(dir, { recursive: true, force: true })
})

async function search(input: Record<string, unknown>) {
  const outcome = await registry.runTool(
    "search_logs",
    { ...input, dataset: "bgl", sort: "time_asc" },
    { client: "test", signal: new AbortController().signal }
  )
  if (!outcome.ok) throw new Error(outcome.error.message)
  return {
    ...outcome.result,
    data: searchLogs.output.parse(outcome.result.data),
  }
}

describe("search_logs index match ranges", () => {
  it.each([
    ["terms", "ÄRGER", [{ start: 0, end: 5 }]],
    [
      "terms",
      "cache parity",
      [
        { start: 8, end: 13 },
        { start: 14, end: 20 },
        { start: 28, end: 33 },
      ],
    ],
    ["phrase", "cache parity error", [{ start: 8, end: 26 }]],
    [
      "fuzzy",
      "cahce",
      [
        { start: 8, end: 13 },
        { start: 28, end: 33 },
      ],
    ],
  ])(
    "returns %s index matches in zero-based Unicode code points",
    async (match, query, ranges) => {
      const result = await search({ query, match })
      expect(result.data.hits[0]).toMatchObject({
        event_id: 1,
        message: MESSAGE,
        match_ranges: ranges,
      })
      const receipt = await new FileReceiptStore(dir).get(
        result.receipt.receipt_id
      )
      expect(receipt?.sql.at(-1)).toContain(
        "ts_offsets(log_events_idx.message)"
      )
      expect(receipt?.result).toEqual(result.data)
    }
  )

  it("keeps a hit whose only match is beyond the 400-code-point prefix", async () => {
    const { data } = await search({ query: "lateword" })
    expect(data.total_matches).toBe(1)
    expect(data.hits).toMatchObject([
      {
        event_id: 2,
        message: "😀 " + "ä".repeat(397) + " ",
        message_truncated: true,
        match_ranges: [],
      },
    ])
  })

  it("clips a partly visible range and keeps a range ending at the cutoff", async () => {
    const { data } = await search({ query: "cache" })
    expect(data.hits.find((hit) => hit.event_id === 3)).toMatchObject({
      message: "😀 " + "ä".repeat(395) + " ca",
      message_truncated: true,
      match_ranges: [{ start: 398, end: 400 }],
    })
    expect(data.hits.find((hit) => hit.event_id === 4)).toMatchObject({
      message_truncated: false,
      match_ranges: [{ start: 395, end: 400 }],
    })
  })

  it("merges overlapping phrase matches into one visible range", async () => {
    const { data } = await search({ query: "cache cache", match: "phrase" })
    expect(data.total_matches).toBe(1)
    expect(data.hits).toMatchObject([
      {
        event_id: 6,
        message: "cache cache cache",
        match_ranges: [{ start: 0, end: 17 }],
      },
    ])
  })

  it("marks both term lengths in a two-edit fuzzy expansion", async () => {
    const { data } = await search({
      query: "cahce",
      match: "fuzzy",
      max_edits: 2,
    })
    expect(data.hits.find((hit) => hit.event_id === 7)).toMatchObject({
      message: "😀 cache icache",
      match_ranges: [
        { start: 2, end: 7 },
        { start: 8, end: 14 },
      ],
    })
  })

  it("preserves literal markup in untrusted log text without adding markup", async () => {
    const { data } = await search({ query: "cache parity" })
    expect(data.hits.find((hit) => hit.event_id === 5)).toMatchObject({
      message: MARKUP,
      match_ranges: [
        { start: 8, end: 13 },
        { start: 28, end: 34 },
      ],
    })
  })
})
