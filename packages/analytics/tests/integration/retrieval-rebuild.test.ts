/** Synthetic vectors test snapshot recovery, never semantic quality. */
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"

import { afterAll, beforeAll, expect, it } from "vitest"

import { createDatabase, type Database } from "../../src/db.ts"
import { buildRetrievalSnapshot, messageDigest } from "../../src/retrieval.ts"
import { buildFixtureDatabase, fixtureConnection } from "./fixtures.ts"
import { loadEnv, temporaryDir } from "./helpers.ts"

loadEnv()
const database = `log_insights_retrieval_rebuild_${process.pid}`
const input = {
  version: 1,
  provider: "synthetic-fixture-only",
  model: "hand-authored-vector",
  model_version: "fixture-v1",
  dimensions: 3,
  normalization: "l2",
  preprocessing_version: "message-v1",
  data_version: "dv_fixture000000000",
  events: [
    {
      event_id: 1,
      message_sha256: messageDigest("cache parity error"),
      embedding: [1, 0, 0],
    },
  ],
  queries: [{ query: "memory integrity fault", embedding: [1, 0, 0] }],
}
let db: Database | undefined
let directory: string | undefined
let snapshotId: string | undefined
const signal = new AbortController().signal
beforeAll(async () => {
  await buildFixtureDatabase(database, [
    {
      event_id: 1,
      dataset: "bgl",
      ts: "2005-07-01T00:00:00Z",
      level: "FATAL",
      component: "KERNEL",
      message: "cache parity error",
    },
  ])
  db = createDatabase(fixtureConnection(database))
  directory = await temporaryDir("retrieval-rebuild-")
})
afterAll(async () => {
  if (db !== undefined) {
    if (snapshotId !== undefined) {
      const table = `log_retrieval_${snapshotId.slice(0, 32)}`
      await db.query(`DROP TABLE IF EXISTS ${table} CASCADE`, [], signal)
      await db.query(
        `DROP TEXT SEARCH DICTIONARY IF EXISTS ${table}_text`,
        [],
        signal
      )
    }
    await db.dispose()
  }
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true })
})

it("restores the same persisted snapshot after owned DB objects disappear and preserves its table when only the index disappears", async () => {
  if (db === undefined || directory === undefined)
    throw new Error("Fixture not ready")
  const original = await buildRetrievalSnapshot(db, input, directory, signal)
  snapshotId = original.snapshot_id
  const table = `log_retrieval_${snapshotId.slice(0, 32)}`
  const persisted = JSON.parse(
    await readFile(join(directory, `${snapshotId}.import.json`), "utf8")
  )
  await db.query(`DROP TABLE ${table} CASCADE`, [], signal)
  await db.query(`DROP TEXT SEARCH DICTIONARY ${table}_text`, [], signal)
  expect(
    await buildRetrievalSnapshot(db, persisted, directory, signal)
  ).toEqual(original)
  await db.query(`DROP INDEX ${table}_idx`, [], signal)
  expect(
    await buildRetrievalSnapshot(db, persisted, directory, signal)
  ).toEqual(original)
  const counted = await db.query(
    `SELECT count(*) AS total FROM ${table}_idx`,
    [],
    signal
  )
  expect(counted.rows[0]).toEqual({ total: "1" })
})
