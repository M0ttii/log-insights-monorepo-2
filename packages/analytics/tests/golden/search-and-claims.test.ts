/** Author: Codex root, independent LOG-13 verifier; SQL from A-05/A-14 and gate G10. */
import { randomBytes } from "node:crypto"

import { checkClaimsOutputSchema } from "@workspace/domain/tools/check-claims"
import { latencyStatsOutputSchema } from "@workspace/domain/tools/latency-stats"
import { searchLogsOutputSchema } from "@workspace/domain/tools/search-logs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { createGoldenHarness, integer, type GoldenHarness } from "./helpers.ts"

let golden: GoldenHarness
beforeAll(async () => {
  golden = await createGoldenHarness()
})
afterAll(async () => {
  await golden?.close()
})

const countSchema = z.object({ events: integer })
const hitSchema = z.object({
  event_id: integer,
  dataset: z.string(),
  ts: z.string(),
  component: z.string().nullable(),
  level: z.string().nullable(),
  node: z.string().nullable(),
  alert_label: z.string().nullable(),
  request_id: z.string().nullable(),
  message: z.string().nullable(),
  message_truncated: z.boolean(),
})

// These predicates deliberately scan raw messages, never @@ or the filter compiler.
const searchCases = [
  {
    name: "terms full corpus, S-06 limit 50",
    query: "parity",
    match: "terms",
    predicate: "regexp_matches(lower(message), '\\bparity\\b')",
    filters: {},
    where: "dataset = 'bgl'",
  },
  {
    name: "terms AND with component and half-open time filter",
    query: "cache parity",
    match: "terms",
    predicate:
      "regexp_matches(lower(message), '\\bcache\\b') AND regexp_matches(lower(message), '\\bparity\\b')",
    filters: {
      components: ["KERNEL"],
      from: "2005-06-04T00:00:00Z",
      to: "2005-07-01T00:00:00Z",
    },
    where:
      "dataset = 'bgl' AND component = 'KERNEL' AND ts >= '2005-06-04T00:00:00Z'::TIMESTAMPTZ AND ts < '2005-07-01T00:00:00Z'::TIMESTAMPTZ",
  },
  {
    name: "S-07 no matching events",
    query: "goldenunobservedtokenzzzz",
    match: "terms",
    predicate:
      "regexp_matches(lower(message), '\\bgoldenunobservedtokenzzzz\\b')",
    filters: {},
    where: "dataset = 'bgl'",
  },
  {
    name: "phrase against normalized substring",
    query: "cache parity error",
    match: "phrase",
    predicate:
      "contains(' ' || regexp_replace(lower(message), '[^a-z0-9]+', ' ', 'g') || ' ', ' cache parity error ')",
    filters: {},
    where: "dataset = 'bgl'",
  },
]

describe("search_logs independent message scans", () => {
  for (const entry of searchCases) {
    it(`${entry.name}`, async () => {
      const [expected] = await golden.sql(
        `SELECT count(*) AS events FROM log_events WHERE ${entry.where} AND (${entry.predicate})`,
        [],
        countSchema
      )
      expect(expected).toBeDefined()
      const hits = await golden.sql(
        `SELECT event_id, dataset, strftime(ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS ts,
        component, level, node, alert_label, request_id, substring(message, 1, 400) AS message,
        length(message) > 400 AS message_truncated FROM log_events
        WHERE ${entry.where} AND (${entry.predicate}) ORDER BY ts, event_id LIMIT 50`,
        [],
        hitSchema
      )
      const result = await golden.run(
        "search_logs",
        {
          dataset: "bgl",
          query: entry.query,
          match: entry.match,
          sort: "time_asc",
          limit: 50,
          ...entry.filters,
        },
        searchLogsOutputSchema
      )
      expect(result.data.total_matches).toBe(expected?.events)
      expect(result.data.hits.map((hit) => hitSchema.parse(hit))).toEqual(hits)
      expect(result.data.truncated).toBe((expected?.events ?? 0) > 50)
      expect(result.receipt.truncated).toBe(result.data.truncated)
      expect(result.data.match_mode).toBe(entry.match)
      const empty = entry.name.startsWith("S-07")
      expect(result.data.hits).toHaveLength(empty ? 0 : 50)
      expect(result.data.total_matches).toBeGreaterThanOrEqual(empty ? 0 : 51)
      expect(
        result.notes.some((note) => /no matching events/i.test(note))
      ).toBe(empty)
      const repeated = await golden.run(
        "search_logs",
        result.receipt.input,
        searchLogsOutputSchema
      )
      expect(repeated.receipt.result_digest).toBe(result.receipt.result_digest)
      expect(
        await golden.receipts.get(result.receipt.receipt_id)
      ).toMatchObject({ client: "test", result: result.data })
    })
  }

  for (const [query, edits] of [
    ["parrity", 1],
    ["parriity", 1],
    ["parriity", 2],
  ] as const) {
    it(`fuzzy ${query}, distance ${edits}, independent token-distance enumeration`, async () => {
      const from = "2005-06-03T00:00:00Z"
      const to = "2005-06-05T00:00:00Z"
      // Gate G10: fixed typo distances 1/2. ICU tokenization is the data's dictionary;
      // matching uses scalar distance on distinct message tokens, not index expansion.
      const tokens = await golden.sql(
        `WITH vocabulary AS (
        SELECT DISTINCT unnest(ts_lexize('log_text', message)) AS word
        FROM log_events WHERE dataset = $1 AND component = $2 AND ts >= $3::TIMESTAMPTZ AND ts < $4::TIMESTAMPTZ
      ) SELECT word FROM vocabulary WHERE damerau_levenshtein(word, $5) <= $6 ORDER BY word`,
        ["bgl", "KERNEL", from, to, query, edits],
        z.object({ word: z.string() })
      )
      expect(tokens.map((row) => row.word)).toEqual(
        query === "parriity" && edits === 1 ? [] : ["parity"]
      )
      // The explicit vocabulary check proves the term cap cannot affect this case.
      const expected = await golden.sql(
        `SELECT count(*) AS events FROM log_events
        WHERE dataset = $1 AND component = $2 AND ts >= $3::TIMESTAMPTZ AND ts < $4::TIMESTAMPTZ
          AND EXISTS (SELECT 1 FROM unnest(ts_lexize('log_text', message)) AS tokens(word)
            WHERE damerau_levenshtein(word, $5) <= $6)`,
        ["bgl", "KERNEL", from, to, query, edits],
        countSchema
      )
      const result = await golden.run(
        "search_logs",
        {
          dataset: "bgl",
          components: ["KERNEL"],
          from,
          to,
          query,
          match: "fuzzy",
          max_edits: edits,
          sort: "time_asc",
          limit: 50,
        },
        searchLogsOutputSchema
      )
      expect(result.data.total_matches).toBe(expected[0]?.events)
      expect(result.data.max_edits).toBe(edits)
      expect(result.data.truncated).toBe(
        result.data.total_matches !== null && result.data.total_matches > 50
      )
    })
  }
})

it("check_claims verifies independently counted requests and catches each mismatch and unknown", async () => {
  const [expected] = await golden.sql(
    "SELECT count(DISTINCT request_id) AS events FROM log_events WHERE dataset = 'openstack' AND http_status IS NOT NULL",
    [],
    countSchema
  )
  if (!expected) throw new Error("Missing aggregate")
  const source = await golden.run("latency_stats", {}, latencyStatsOutputSchema)
  expect(source.data.total.unique_requests).toBe(expected.events)
  const fact = source.facts.find(
    (item) => item.path === "/result/total/unique_requests"
  )
  if (!fact) throw new Error("Missing requests fact")
  expect(fact.value).toBe(expected.events)
  expect(fact.metric).toBe("unique_requests")
  expect(fact.unit).toBe("requests")
  expect(fact.group).toEqual({})
  const verified = {
    fact: fact.id,
    value: expected.events,
    metric: "unique_requests",
    group: {},
  }
  const absent = `r_${randomBytes(4).toString("hex")}`
  expect(await golden.receipts.get(absent)).toBeNull()
  const result = await golden.run(
    "check_claims",
    {
      claims: [
        verified,
        { ...verified, value: expected.events + 1 },
        { ...verified, metric: "errors" },
        { ...verified, group: { dataset: "bgl" } },
        { ...verified, fact: `${source.receipt.receipt_id}.f999999` },
        { ...verified, fact: `${absent}.f1` },
      ],
    },
    checkClaimsOutputSchema
  )
  expect(
    result.data.claims.map((item) => ({
      status: item.status,
      mismatch_on: item.mismatch_on,
    }))
  ).toEqual([
    { status: "verified", mismatch_on: [] },
    { status: "mismatch", mismatch_on: ["value"] },
    { status: "mismatch", mismatch_on: ["metric"] },
    { status: "mismatch", mismatch_on: ["group"] },
    { status: "unknown_fact", mismatch_on: [] },
    { status: "unknown_receipt", mismatch_on: [] },
  ])
  expect(result.data.summary).toMatchObject({
    checked: 6,
    verified: 1,
    mismatch: 3,
    unresolved: 2,
  })
  expect(result.receipt.sql).toEqual([])
})
