/** Author: independent LOG-41 verifier. Synthetic vectors test mechanics only. */
import { rm } from "node:fs/promises"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import { buildRetrievalSnapshot, messageDigest } from "../../src/retrieval.ts"
import { searchLogs } from "../../src/tools/search-logs.ts"
import { buildFixtureDatabase, fixtureConnection } from "./fixtures.ts"
import { loadEnv, temporaryDir } from "./helpers.ts"

loadEnv()
const DATABASE = `log_insights_log41_retrieval_${process.pid}`
const ROWS = [
  {
    event_id: 1,
    dataset: "bgl",
    ts: "2005-07-01T00:00:00Z",
    level: "FATAL",
    component: "KERNEL",
    message: "cache parity error",
    embedding: [1, 0, 0],
  },
  {
    event_id: 2,
    dataset: "bgl",
    ts: "2005-07-01T00:01:00Z",
    level: "INFO",
    component: "KERNEL",
    message: "network unreachable",
    embedding: [0, 1, 0],
  },
  {
    event_id: 3,
    dataset: "bgl",
    ts: "2005-07-01T00:02:00Z",
    level: "INFO",
    component: "APP",
    message: "temperature normal",
    embedding: [0, 0, 1],
  },
  {
    event_id: 10_000_001,
    dataset: "openstack",
    ts: "2017-05-14T00:00:00Z",
    level: "ERROR",
    component: "nova-api",
    message: "cache parity error",
    embedding: [1, 0, 0],
  },
] as const
let db: Database
let registry: Registry
let directory: string
let snapshot: string
let previousDirectory: string | undefined
const call = () => ({
  client: "test" as const,
  signal: new AbortController().signal,
})

beforeAll(async () => {
  await buildFixtureDatabase(DATABASE, ROWS)
  db = createDatabase(fixtureConnection(DATABASE))
  directory = await temporaryDir("log41-retrieval-")
  previousDirectory = process.env.LOG_INSIGHTS_RETRIEVAL_DIR
  process.env.LOG_INSIGHTS_RETRIEVAL_DIR = directory
  registry = createRegistry({
    db,
    receipts: new FileReceiptStore(directory),
    log: () => undefined,
  })
  const manifest = await buildRetrievalSnapshot(
    db,
    {
      version: 1,
      provider: "synthetic-fixture-no-provider",
      model: "hand-authored-orthogonal-vectors-v1",
      model_version: "fixture-v1",
      dimensions: 3,
      normalization: "l2",
      preprocessing_version: "message-v1",
      data_version: "dv_fixture000000000",
      events: ROWS.map((row) => ({
        event_id: row.event_id,
        message_sha256: messageDigest(row.message),
        embedding: [...row.embedding],
      })),
      queries: [
        { query: "memory integrity fault", embedding: [1, 0, 0] },
        { query: "cache parity error", embedding: [0, 1, 0] },
      ],
    },
    directory,
    call().signal
  )
  snapshot = manifest.snapshot_id
})
afterAll(async () => {
  if (previousDirectory === undefined)
    delete process.env.LOG_INSIGHTS_RETRIEVAL_DIR
  else process.env.LOG_INSIGHTS_RETRIEVAL_DIR = previousDirectory
  if (db !== undefined) {
    if (snapshot !== undefined)
      await db.query(
        `DROP TABLE log_retrieval_${snapshot.slice(0, 32)} CASCADE`,
        [],
        call().signal
      )
    await db.dispose()
  }
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true })
})
async function search(input: Record<string, unknown>) {
  const outcome = await registry.runTool("search_logs", input, call())
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
  return {
    ...outcome.result,
    data: searchLogs.output.parse(outcome.result.data),
  }
}

describe("LOG-41 independently defined retrieval references", () => {
  it("preserves terms, phrase and fuzzy against handwritten evidence", async () => {
    for (const input of [
      { query: "cache parity" },
      { query: "cache parity error", match: "phrase" },
      { query: "parrity", match: "fuzzy" },
    ]) {
      const result = await search({ ...input, dataset: "bgl" })
      expect(result.data.total_matches).toBe(1)
      expect(result.data.hits.map((hit) => hit.event_id)).toEqual([1])
    }
  })
  it("retrieves unknown wording, filters before top-k, and never claims an exhaustive count", async () => {
    const lexical = await search({
      query: "memory integrity fault",
      dataset: "bgl",
    })
    expect(lexical.data.hits).toEqual([])
    const semantic = await search({
      query: "memory integrity fault",
      dataset: "bgl",
      match: "semantic",
      retrieval_snapshot: snapshot,
      limit: 1,
    })
    expect(semantic.data.hits.map((hit) => hit.event_id)).toEqual([1])
    expect(semantic.data.total_matches).toBeNull()
    expect(semantic.receipt.population).toBeNull()
    const filtered = await search({
      query: "memory integrity fault",
      dataset: "bgl",
      components: ["APP"],
      match: "semantic",
      retrieval_snapshot: snapshot,
      limit: 1,
    })
    expect(filtered.data.hits.map((hit) => hit.event_id)).toEqual([3])
    expect(filtered.data.hits[0]?.score).toBe(1)
    expect(semantic.notes.join(" ")).toMatch(/neither.*causal|not.*caus/i)
  })
  it("fuses lexical and orthogonal-vector ranks with RRF k=60", async () => {
    const hybrid = await search({
      query: "cache parity error",
      dataset: "bgl",
      match: "hybrid",
      retrieval_snapshot: snapshot,
      limit: 3,
    })
    expect(hybrid.data.hits.map((hit) => hit.event_id)).toEqual([1, 2, 3])
    // Hand-derived: semantic ranks = 2,1,3; lexical has only event 1 at rank 1.
    expect(hybrid.data.hits[0]?.score).toBeCloseTo(1 / 62 + 1 / 61, 12)
    expect(hybrid.data.hits[1]?.score).toBeCloseTo(1 / 61, 12)
    expect(hybrid.data.hits[2]?.score).toBeCloseTo(1 / 63, 12)
  })
  it("returns filtered emptiness and explicitly rejects absent query/provider", async () => {
    const empty = await search({
      query: "memory integrity fault",
      dataset: "bgl",
      components: ["missing"],
      match: "semantic",
      retrieval_snapshot: snapshot,
    })
    expect(empty.data.hits).toEqual([])
    const absent = await registry.runTool(
      "search_logs",
      {
        query: "unrepresented wording",
        dataset: "bgl",
        match: "semantic",
        retrieval_snapshot: snapshot,
      },
      call()
    )
    expect(absent.ok ? null : absent.error).toMatchObject({
      code: "invalid_input",
      hint: expect.stringContaining("No lexical fallback"),
    })
  })
  it("repeats and reruns one immutable representation with genuine fact IDs", async () => {
    const input = {
      query: "memory integrity fault",
      dataset: "bgl",
      match: "semantic",
      retrieval_snapshot: snapshot,
      limit: 2,
    }
    const first = await search(input)
    const second = await search(input)
    expect(second.receipt.result_digest).toBe(first.receipt.result_digest)
    expect(
      first.facts.every((fact) => fact.id.startsWith(first.receipt.receipt_id))
    ).toBe(true)
    const rerun = await registry.rerun(first.receipt.receipt_id, call())
    expect(rerun.ok ? rerun.matches : rerun.error).toEqual({
      signature: true,
      data_version: true,
      result_digest: true,
    })
  })
})
