/**
 * search_logs through the registry against SereneDB with the Loghub 2k
 * samples (`pnpm data:setup --samples`).
 *
 * Expected values were determined from the raw sample files, not from the
 * loader or the tool: a Python script split BGL_2k.log into its ten fields
 * (message = everything after the level) and OpenStack_2k.log into file,
 * time, level, logger and the message after the request block, lower-cased
 * the message and tokenised it with `[a-z0-9_]+([.:'][a-z0-9_]+)*`, which
 * equals the index tokenisation for the chosen words (their contexts were
 * listed and are plain words between spaces or punctuation). Phrases were
 * counted with a regex over adjacent words, fuzzy terms with an optimal
 * string alignment distance over the token vocabulary of both files. BGL
 * times are the Unix seconds of the line plus the microseconds of its text
 * timestamp, in UTC.
 */
import { rm } from "node:fs/promises"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import { searchLogs } from "../../src/tools/search-logs.ts"
import { loadEnv, samplesConnection, temporaryDir } from "./helpers.ts"

loadEnv()

const BGL_FIRST = "2005-06-03T22:42:50.675872Z"
const BGL_END = "2006-01-03T15:13:09.127919Z"
/** BGL lines 2 and 3: `1117838573 … 15.42.53.276129` and `1117838976 … 15.49.36.156884`. */
const LINE_2_TS = "2005-06-03T22:42:53.276129Z"
const LINE_3_TS = "2005-06-03T22:49:36.156884Z"

/** BGL line 1203, the only sample message longer than 400 characters (409). */
const LONG_MESSAGE =
  "Node card status: ALERT 0, ALERT 1, ALERT 2, ALERT 3 is (are) active. Clock Mode is Low. Clock Select is Midplane. Phy JTAG Reset is asserted. ASIC JTAG Reset is not asserted. Temperature Mask is not active. No temperature error. Temperature Limit Error Latch is clear. PGOOD is asserted. PGOOD error latch is clear. MPGOOD is OK. MPGOOD error latch is clear. The 2.5 volt rail is OK. The 1.5 volt rail is OK."

let db: Database
let dir: string
let registry: Registry

beforeAll(async () => {
  db = createDatabase(samplesConnection())
  dir = await temporaryDir("analytics-search-")
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

const call = () => ({
  client: "test" as const,
  signal: new AbortController().signal,
})

async function run(input: Record<string, unknown>) {
  return registry.runTool("search_logs", input, call())
}

async function search(input: Record<string, unknown>) {
  const outcome = await run(input)
  if (!outcome.ok) throw new Error(outcome.error.message)
  return {
    ...outcome.result,
    data: searchLogs.output.parse(outcome.result.data),
  }
}

async function total(input: Record<string, unknown>) {
  return (await search({ limit: 1, ...input })).data.total_matches
}

describe("match terms", () => {
  it("counts a known term exactly, alone and with filters", async () => {
    // parity: 48 BGL lines (all KERNEL INFO), none in OpenStack.
    expect(await total({ query: "parity" })).toBe(48)
    // error: 238 BGL lines; 61 of them FATAL, KERNEL, in June 2005 (UTC).
    expect(await total({ query: "error" })).toBe(238)
    expect(
      await total({
        query: "error",
        dataset: "bgl",
        from: "2005-06-01T00:00:00Z",
        to: "2005-07-01T00:00:00Z",
        levels: ["FATAL"],
        components: ["KERNEL"],
      })
    ).toBe(61)
    // error with an R-02 error level (FATAL, ERROR, SEVERE, FAILURE): 158; with label KERNDTLB: 60.
    expect(await total({ query: "error", only_errors: true })).toBe(158)
    expect(await total({ query: "error", alert_label: "KERNDTLB" })).toBe(60)
  })

  it("searches both datasets without a dataset and resolves teams", async () => {
    // instance: 51 BGL lines (KERNEL) and 646 OpenStack lines (619 nova-compute).
    expect(await total({ query: "instance" })).toBe(697)
    expect(await total({ query: "instance", dataset: "openstack" })).toBe(646)
    // Compute Platform owns KERNEL and nova-compute (fictional ownership).
    expect(
      await total({ query: "instance", teams: ["Compute Platform"] })
    ).toBe(670)
    // OpenStack line 1 is the only line of req-38101a0b-….
    expect(
      await total({
        query: "status",
        dataset: "openstack",
        request_id: "req-38101a0b-2096-447d-96ea-a692162415ae",
      })
    ).toBe(1)
  })

  it("joins words with AND, not OR", async () => {
    // cache: 51 lines, parity: 48, both: 48; OR would give 51.
    expect(await total({ query: "cache" })).toBe(51)
    const result = await search({ query: "cache parity", limit: 50 })
    expect(result.data.total_matches).toBe(48)
    expect(result.data.hits).toHaveLength(48)
    for (const hit of result.data.hits)
      expect(hit.message?.toLowerCase()).toMatch(/\bcache\b.*\bparity\b/)
  })

  it("returns the exact total, 50 hits and truncated for more than 50 matches (S-06)", async () => {
    // generating: 721 lines ("generating core.<n>").
    const result = await search({ query: "generating", limit: 50 })
    expect(result.data).toMatchObject({
      total_matches: 721,
      truncated: true,
      row_limit: 50,
    })
    expect(result.data.hits).toHaveLength(50)
    expect(result.receipt.population).toEqual({
      count: 721,
      unit: "log_events",
    })
    expect(result.receipt.rows_returned).toBe(50)
    expect(result.notes).toContain(
      "Truncated: 50 of 721 matches shown; total_matches is exact. Narrow the query, window or filters to see other lines, and use count_events for frequencies."
    )
    const fact = result.facts.find((f) => f.path === "/result/total_matches")
    expect(fact).toMatchObject({
      value: 721,
      metric: "matches",
      unit: "log_events",
      group: {},
    })
  })

  it("says so explicitly when nothing matches (S-07)", async () => {
    const result = await search({
      query: "qqqzzz",
      dataset: "bgl",
      levels: ["FATAL"],
    })
    expect(result.data).toMatchObject({
      total_matches: 0,
      hits: [],
      truncated: false,
    })
    expect(result.notes).toEqual([
      "Matches are log events, not incidents; do not infer frequencies from hits – use count_events.",
      `No matching events for "qqqzzz" (match terms) in bgl [${BGL_FIRST}, ${BGL_END}) with levels=["FATAL"].`,
    ])
  })

  it("rejects a query without searchable words", async () => {
    const outcome = await run({ query: "!!! --- ***" })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "query" }],
    })
  })

  it("rejects request_id with dataset bgl", async () => {
    const outcome = await run({
      query: "parity",
      dataset: "bgl",
      request_id: "req-1",
    })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      issues: [
        {
          path: "request_id",
          message: "Only available for dataset openstack.",
        },
      ],
    })
  })
})

describe("hits", () => {
  it("includes an event exactly on from and excludes one exactly on to", async () => {
    const result = await search({
      query: "parity",
      dataset: "bgl",
      from: LINE_2_TS,
      to: LINE_3_TS,
    })
    expect(result.data.hits.map((hit) => [hit.event_id, hit.ts])).toEqual([
      [2, LINE_2_TS],
    ])
  })

  it("ranks by BM25 descending with event_id ascending on ties", async () => {
    const { data } = await search({ query: "error", limit: 50 })
    const order = data.hits.map((hit) => [hit.score, hit.event_id])
    const expected = order.toSorted(
      ([scoreA = 0, idA = 0], [scoreB = 0, idB = 0]) =>
        scoreB - scoreA || idA - idB
    )
    expect(order).toEqual(expected)
    expect(new Set(order.map(([score]) => score)).size).toBeGreaterThan(1)
  })

  it("sorts by time in both directions", async () => {
    const ascending = await search({
      query: "parity",
      sort: "time_asc",
      limit: 3,
    })
    expect(ascending.data.hits.map((hit) => [hit.event_id, hit.ts])).toEqual([
      [1, BGL_FIRST],
      [2, LINE_2_TS],
      [3, LINE_3_TS],
    ])
    const descending = await search({
      query: "parity",
      sort: "time_desc",
      limit: 1,
    })
    // The last parity line of the sample is BGL line 1999.
    expect(descending.data.hits.map((hit) => hit.event_id)).toEqual([1999])
  })

  it("cuts messages to 400 characters and marks them", async () => {
    // mpgood: 6 lines, among them line 1203.
    const { data } = await search({ query: "mpgood", sort: "time_asc" })
    expect(data.total_matches).toBe(6)
    const long = data.hits.find((hit) => hit.event_id === 1203)
    expect(long).toMatchObject({
      message: LONG_MESSAGE.slice(0, 400),
      message_truncated: true,
    })
    expect(data.hits.filter((hit) => hit.message_truncated)).toHaveLength(1)
  })

  it("stores a receipt with every SQL text, parameters, mode and population", async () => {
    const result = await search({
      query: "cache parity",
      dataset: "bgl",
      limit: 5,
    })
    const { receipt } = result
    const stored = await new FileReceiptStore(dir).get(receipt.receipt_id)
    if (stored === null) throw new Error("receipt missing")
    expect(stored.input).toEqual({
      query: "cache parity",
      match: "terms",
      dataset: "bgl",
      sort: "relevance",
      limit: 5,
    })
    expect(stored.sql).toHaveLength(4)
    expect(stored.sql[0]).toContain("ts_lexize")
    expect(stored.sql[1]).toContain("FROM corpus_stats")
    expect(stored.sql[2]).toBe(
      "SELECT count(*) AS total FROM log_events_idx WHERE log_events_idx.message @@ plainto_tsquery($1) AND log_events_idx.dataset = $2"
    )
    expect(stored.sql[3]).toContain(
      "WHERE log_events_idx.message @@ plainto_tsquery($1) AND log_events_idx.dataset = $2 ORDER BY BM25(log_events_idx.tableoid) DESC, log_events_idx.event_id LIMIT $3"
    )
    expect(stored.params).toEqual([
      ["cache parity"],
      ["bgl"],
      ["cache parity", "bgl"],
      ["cache parity", "bgl", 5],
    ])
    expect(stored.population).toEqual({ count: 48, unit: "log_events" })
    expect(stored.result).toMatchObject({
      match_mode: "terms",
      total_matches: 48,
    })
    expect(stored.scope).toEqual({
      windows: [{ dataset: "bgl", from: BGL_FIRST, to: BGL_END }],
      filters: {},
    })
    expect(stored.duration_ms).toBeGreaterThan(0)
    expect(
      stored.facts.filter((fact) => fact.metric === "event_time")
    ).toHaveLength(5)
  })

  it("is reproducible: same digest on a second run and on rerun", async () => {
    for (const input of [
      { query: "error", limit: 50 },
      { query: "cache parity error", match: "phrase" },
      { query: "cahce", match: "fuzzy", max_edits: 2, limit: 50 },
    ]) {
      const first = await search(input)
      const second = await search(input)
      expect(second.receipt.signature).toBe(first.receipt.signature)
      expect(second.receipt.result_digest).toBe(first.receipt.result_digest)
      const rerun = await registry.rerun(first.receipt.receipt_id, call())
      expect(rerun.ok ? rerun.matches : rerun.error).toEqual({
        signature: true,
        data_version: true,
        result_digest: true,
      })
    }
  })
})

describe("match phrase", () => {
  it("counts adjacent words in order; count equals the hit list", async () => {
    // "cache parity error": 42 lines; the other 6 parity lines read "data cache search parity error".
    const result = await search({
      query: "Cache Parity Error",
      match: "phrase",
      limit: 50,
    })
    expect(result.data).toMatchObject({
      total_matches: 42,
      truncated: false,
      match_mode: "phrase",
    })
    expect(result.data.hits).toHaveLength(42)
    expect(await total({ query: "parity error", match: "phrase" })).toBe(48)
    expect(await total({ query: "error parity cache", match: "phrase" })).toBe(
      0
    )
  })

  it("only tokenises query syntax", async () => {
    expect(
      await total({ query: '"cache parity" -error', match: "phrase" })
    ).toBe(42)
  })
})

describe("match fuzzy", () => {
  it("finds a term with one typo, case-insensitively; count equals the hit list", async () => {
    // parrity → parity (one edit): the 48 parity lines.
    const result = await search({ query: "PARRITY", match: "fuzzy", limit: 50 })
    expect(result.data).toMatchObject({
      total_matches: 48,
      max_edits: 1,
      match_mode: "fuzzy",
    })
    expect(result.data.hits).toHaveLength(48)
    expect(result.notes).toContain(
      "Fuzzy: terms within 1 edit(s) of the query term, at most 50 index terms per index segment (closest first); spellings beyond that cap are neither counted nor listed."
    )
  })

  it("widens with max_edits 2", async () => {
    // cahce: distance 1 reaches cache (51 lines, swap counts as one edit); distance 2 also icache (54).
    expect(await total({ query: "cahce", match: "fuzzy" })).toBe(51)
    expect(await total({ query: "cahce", match: "fuzzy", max_edits: 2 })).toBe(
      54
    )
    // instanse: instance (697) at 1, also instances (974) at 2.
    expect(
      await total({ query: "instanse", match: "fuzzy", max_edits: 1 })
    ).toBe(697)
    expect(
      await total({ query: "instanse", match: "fuzzy", max_edits: 2 })
    ).toBe(974)
  })

  it("rejects invalid combinations with a hint", async () => {
    const withTerms = await run({ query: "parity", max_edits: 1 })
    expect(withTerms.ok ? null : withTerms.error).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "max_edits" }],
    })
    const distance3 = await run({
      query: "parity",
      match: "fuzzy",
      max_edits: 3,
    })
    expect(distance3.ok ? null : distance3.error).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "max_edits" }],
    })
    const twoTerms = await run({ query: "cache parity", match: "fuzzy" })
    expect(twoTerms.ok ? null : twoTerms.error).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "query" }],
      hint: 'Search one term with match "fuzzy", or use match "terms" (all words) or "phrase" (word sequence).',
    })
  })
})
