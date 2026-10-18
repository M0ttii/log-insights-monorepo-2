import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { QueryFailure } from "./db.ts"
import {
  buildRetrievalSnapshot,
  embedRetrievalImport,
  openRetrieval,
  messageDigest,
  retrievalDigest,
} from "./retrieval.ts"

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

const imported = {
  version: 1,
  provider: "fixture-only",
  model: "fixture-model-v1",
  model_version: "v1",
  dimensions: 3,
  normalization: "l2",
  preprocessing_version: "message-v1",
  data_version: "dv_fixture",
  events: [
    {
      event_id: 1,
      message_sha256: messageDigest("socket exhausted"),
      embedding: [1, 0, 0],
    },
  ],
  queries: [{ query: "connection capacity", embedding: [1, 0, 0] }],
}

describe("immutable retrieval representation", () => {
  it("publishes only after real-vector index SQL and source validation succeed, then reuses the same snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retrieval-unit-"))
    directories.push(directory)
    const calls: string[] = []
    let indexBuilt = false
    const db = {
      async query(sql: string) {
        calls.push(sql)
        if (sql.startsWith("SELECT count") && !indexBuilt)
          throw new QueryFailure("failed", "42P01")
        if (sql.startsWith("CREATE INDEX")) indexBuilt = true
        return {
          rows:
            sql === "SELECT data_version FROM load_manifest"
              ? [{ data_version: "dv_fixture" }]
              : sql.startsWith("SELECT event_id")
                ? [{ event_id: "1", message: "socket exhausted" }]
                : sql.startsWith("SELECT count")
                  ? [{ total: "1" }]
                  : [],
          durationMs: 1,
        }
      },
    }
    const snapshot = await buildRetrievalSnapshot(
      db,
      imported,
      directory,
      new AbortController().signal
    )
    expect(
      calls.some((sql) =>
        sql.includes("embedding ivf (metric = 'cosine', quant = 'none')")
      )
    ).toBe(true)
    expect(
      JSON.parse(
        await readFile(join(directory, `${snapshot.snapshot_id}.json`), "utf8")
      )
    ).toEqual(snapshot)
    const count = calls.length
    expect(
      await buildRetrievalSnapshot(
        db,
        imported,
        directory,
        new AbortController().signal
      )
    ).toEqual(snapshot)
    expect(calls.slice(count)).toEqual([
      "SELECT data_version FROM load_manifest",
      expect.stringContaining("SELECT event_id, message FROM log_events"),
      expect.stringContaining("_idx"),
    ])
    expect(
      retrievalDigest({ ...imported, model: "fixture-model-v2" })
    ).not.toBe(retrievalDigest(imported))
  })
  it("refuses changed source messages before modifying any snapshot relation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retrieval-unit-"))
    directories.push(directory)
    const calls: string[] = []
    const db = {
      async query(sql: string) {
        calls.push(sql)
        return {
          rows:
            sql === "SELECT data_version FROM load_manifest"
              ? [{ data_version: "dv_fixture" }]
              : [{ event_id: "1", message: "changed" }],
          durationMs: 1,
        }
      },
    }
    await expect(
      buildRetrievalSnapshot(
        db,
        imported,
        directory,
        new AbortController().signal
      )
    ).rejects.toThrow("Source message mismatch")
    expect(calls.some((sql) => /^(CREATE|DROP|INSERT)/.test(sql))).toBe(false)
  })
  it("rejects incompatible dimensions, zero vectors and false normalization declarations before SQL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retrieval-unit-"))
    directories.push(directory)
    const db = {
      async query() {
        throw new Error("Must not execute")
      },
    }
    for (const embedding of [
      [1, 0],
      [0, 0, 0],
      [2, 0, 0],
    ]) {
      await expect(
        buildRetrievalSnapshot(
          db,
          { ...imported, events: [{ ...imported.events[0], embedding }] },
          directory,
          new AbortController().signal
        )
      ).rejects.toThrow(/embedding|Embedding/)
    }
  })
})

it("builds bounded provider embeddings in SereneDB with bound model and secret identifiers", async () => {
  const calls: { sql: string; params: readonly unknown[] }[] = []
  const db = {
    async query(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params })
      return {
        rows:
          sql === "SELECT data_version FROM load_manifest"
            ? [{ data_version: "dv_fixture" }]
            : sql.includes("ai_embed")
              ? [
                  {
                    event_id: "1",
                    message: "socket exhausted",
                    embedding: [1, 0, 0],
                  },
                ]
              : [{ event_id: "1" }],
        durationMs: 1,
      }
    },
  }
  const { events: _events, queries: _queries, ...meta } = imported
  const result = await embedRetrievalImport(
    db,
    { ...meta, selection: { dataset: "bgl" } },
    "provider_secret",
    new AbortController().signal
  )
  expect(result.events).toEqual(imported.events)
  expect(calls[1]?.params).toEqual(["bgl", 100])
  expect(calls[2]?.params).toEqual(["fixture-model-v1", "provider_secret", 1])
  expect(calls[2]?.sql).toContain(
    "ai_embed(coalesce(message, ''), $1::VARCHAR, $2::VARCHAR)::FLOAT[3]"
  )
  expect(calls[2]?.sql).not.toContain("socket exhausted")
})

it("requires an imported query vector even with a configured provider or an old unverified cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "retrieval-cache-"))
  directories.push(directory)
  vi.stubEnv("LOG_INSIGHTS_RETRIEVAL_DIR", directory)
  vi.stubEnv("LOG_INSIGHTS_EMBEDDING_SECRET", "provider_secret")
  let embeddings = 0
  const db = {
    async query(sql: string) {
      if (sql.includes("ai_embed")) {
        embeddings += 1
        return {
          rows: [{ embedding: embeddings === 1 ? [1, 0, 0] : [0, 1, 0] }],
          durationMs: 1,
        }
      }
      return {
        rows:
          sql === "SELECT data_version FROM load_manifest"
            ? [{ data_version: "dv_fixture" }]
            : sql.startsWith("SELECT event_id")
              ? [{ event_id: "1", message: "socket exhausted" }]
              : sql.startsWith("SELECT count")
                ? [{ total: "1" }]
                : [],
        durationMs: 1,
      }
    },
  }
  const signal = new AbortController().signal
  const snapshot = await buildRetrievalSnapshot(
    db,
    { ...imported, queries: [] },
    directory,
    signal
  )
  const ctx = {
    db,
    signal,
    dataVersion: "dv_fixture",
    client: "test" as const,
    clock: { now: () => "2026-10-18T00:00:00Z" },
    receipts: {
      put: async () => undefined,
      get: async () => null,
      list: async () => [],
    },
  }
  const cacheDir = join(directory, `${snapshot.snapshot_id}-queries`)
  await mkdir(cacheDir)
  await writeFile(
    join(cacheDir, `${retrievalDigest("a new conceptual question")}.json`),
    JSON.stringify({ query: "a new conceptual question", embedding: [0, 1, 0] })
  )
  const first = await openRetrieval(
    ctx,
    snapshot.snapshot_id,
    "a new conceptual question"
  )
  const rerun = await openRetrieval(
    ctx,
    snapshot.snapshot_id,
    "a new conceptual question"
  )
  expect(first.ok).toBe(false)
  expect(rerun.ok).toBe(false)
  if (first.ok || first.error.code !== "invalid_input")
    throw new Error("Expected missing pinned query")
  expect(first.error.issues).toEqual([
    expect.objectContaining({
      message: expect.stringContaining("imported query embedding"),
    }),
  ])
  const withQuery = await buildRetrievalSnapshot(
    db,
    imported,
    directory,
    signal
  )
  vi.stubEnv("LOG_INSIGHTS_EMBEDDING_SECRET", "another_provider_secret")
  const exact = await openRetrieval(
    ctx,
    withQuery.snapshot_id,
    "connection capacity"
  )
  expect(exact.ok).toBe(true)
  if (!exact.ok) throw new Error("Expected imported query")
  expect(exact.embedding).toEqual([1, 0, 0])
  const incompatible = await openRetrieval(
    ctx,
    withQuery.snapshot_id,
    "connection capacity",
    { dataset: "otel" }
  )
  expect(incompatible.ok).toBe(false)
  if (incompatible.ok) throw new Error("Expected dataset mismatch")
  expect(incompatible.error.message).toContain("log_events datasets")
  expect(embeddings).toBe(0)
})

it("restores missing snapshot relations after a database reset without replacing a healthy build", async () => {
  const directory = await mkdtemp(join(tmpdir(), "retrieval-reset-"))
  directories.push(directory)
  const calls: string[] = []
  let tableExists = false
  let indexExists = false
  let dictionaryExists = false
  const db = {
    async query(sql: string) {
      calls.push(sql)
      if (
        sql.startsWith("SELECT count") &&
        !(sql.includes("_idx") ? indexExists : tableExists)
      )
        throw new QueryFailure("failed", "42P01")
      if (sql.startsWith("CREATE TEXT SEARCH DICTIONARY")) {
        if (dictionaryExists) throw new QueryFailure("failed", "42710")
        dictionaryExists = true
      }
      if (sql.startsWith("CREATE TABLE")) tableExists = true
      if (sql.startsWith("CREATE INDEX")) indexExists = true
      return {
        rows:
          sql === "SELECT data_version FROM load_manifest"
            ? [{ data_version: "dv_fixture" }]
            : sql.startsWith("SELECT event_id")
              ? [{ event_id: "1", message: "socket exhausted" }]
              : sql.startsWith("SELECT count")
                ? [{ total: "1" }]
                : [],
        durationMs: 1,
      }
    },
  }
  const signal = new AbortController().signal
  const snapshot = await buildRetrievalSnapshot(db, imported, directory, signal)
  tableExists = false
  indexExists = false
  const restored = await Promise.all([
    buildRetrievalSnapshot(db, imported, directory, signal),
    buildRetrievalSnapshot(db, imported, directory, signal),
  ])
  expect(restored).toEqual([snapshot, snapshot])
  indexExists = false
  expect(await buildRetrievalSnapshot(db, imported, directory, signal)).toEqual(
    snapshot
  )
  expect(calls.filter((sql) => sql.startsWith("CREATE TABLE"))).toHaveLength(2)
  expect(calls.filter((sql) => sql.startsWith("CREATE INDEX"))).toHaveLength(3)
  expect(calls.some((sql) => sql.startsWith("DROP"))).toBe(false)
  expect(
    JSON.parse(
      await readFile(
        join(directory, `${snapshot.snapshot_id}.import.json`),
        "utf8"
      )
    )
  ).toEqual(imported)
})

it("refuses an unbounded or oversized direct OTel build before opening remote files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "retrieval-direct-bound-"))
  directories.push(directory)
  const calls: string[] = []
  const db = {
    async query(sql: string) {
      calls.push(sql)
      if (sql !== "SELECT data_version FROM load_manifest")
        throw new Error("Must not open remote files")
      return { rows: [{ data_version: "dv_fixture" }], durationMs: 1 }
    },
  }
  for (const source of [
    { dataset: "otel", path: "direct_scan" },
    {
      dataset: "otel",
      path: "direct_scan",
      from: "2025-09-23T00:00:00Z",
      to: "2025-09-23T00:01:01Z",
    },
  ]) {
    await expect(
      buildRetrievalSnapshot(
        db,
        { ...imported, source },
        directory,
        new AbortController().signal
      )
    ).rejects.toThrow(/from|seconds/)
  }
  expect(calls).toEqual([
    "SELECT data_version FROM load_manifest",
    "SELECT data_version FROM load_manifest",
  ])
})

it("embeds an OTel replay selection through its canonical adapter with bound filters and model inputs", async () => {
  const eventId = 2_000_000_000_001
  const calls: { sql: string; params: readonly unknown[] }[] = []
  const db = {
    async query(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params })
      const rows =
        sql === "SELECT data_version FROM load_manifest"
          ? [{ data_version: "dv_fixture" }]
          : sql.includes("FROM corpus_stats")
            ? [
                {
                  first: "2025-09-23T00:00:00.000000Z",
                  last: "2025-09-23T00:00:01.000000Z",
                },
              ]
            : sql.includes("FROM otel_replay") &&
                !sql.includes("FROM otel_replay_idx")
              ? [
                  {
                    replay_id: "replay-fixture",
                    replayed_at: "2026-10-18T00:00:00.000000Z",
                    records: "1",
                    fixture_path: "fixture.json",
                    fixture_sha256: "a".repeat(64),
                    source_url: "https://example.org/public-fixture",
                    listener_table: "otel_fixture",
                    index_name: "otel_replay_idx",
                    index_built_at: "2026-10-18T00:00:01.000000Z",
                  },
                ]
              : [
                  {
                    event_id: String(eventId),
                    message: "socket exhausted",
                    embedding: [1, 0, 0],
                  },
                ]
      return { rows, durationMs: 1 }
    },
  }
  const { events: _events, queries: _queries, ...meta } = imported
  const result = await embedRetrievalImport(
    db,
    {
      ...meta,
      source: { dataset: "otel_replay" },
      selection: {
        dataset: "otel_replay",
        components: ["cart"],
        event_ids: [eventId],
      },
    },
    "provider_secret",
    new AbortController().signal
  )
  expect(result.events).toEqual([
    {
      event_id: eventId,
      message_sha256: messageDigest("socket exhausted"),
      embedding: [1, 0, 0],
    },
  ])
  expect(result.source).toEqual({ dataset: "otel_replay" })
  const picked = calls.find((call) => call.sql.includes("LIMIT"))
  expect(picked?.sql).toContain("otel_replay_idx.component IN (")
  expect(picked?.params).toContain("cart")
  const embedded = calls.find((call) => call.sql.includes("ai_embed"))
  expect(embedded?.sql).toContain("FROM otel_replay_idx")
  expect(embedded?.params).toContain("fixture-model-v1")
  expect(embedded?.params).toContain("provider_secret")
  expect(embedded?.sql).not.toContain("provider_secret")
})
