import { readFile, rm } from "node:fs/promises"

import { afterAll, beforeAll, expect, it } from "vitest"
import { z } from "zod"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore, resultDigest } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import {
  buildContextFixtures,
  precursorConnection,
} from "./context-fixtures.ts"
import { loadEnv, samplesConnection, temporaryDir } from "./helpers.ts"
import {
  buildPatternFixtures,
  patternFixtureConnection,
} from "./pattern-fixtures.ts"

loadEnv()
const baseline = z
  .object({
    source_commit: z.string(),
    source: z.string(),
    cases: z.array(
      z.object({
        database: z.enum(["samples", "patterns", "precursors"]),
        name: z.string(),
        tool: z.enum(["recurring_patterns", "get_log_context"]),
        input: z.record(z.string(), z.unknown()),
        result_digest: z.string(),
        facts_sha256: z.string(),
      })
    ),
  })
  .parse(
    JSON.parse(
      await readFile(
        new URL("./fixtures/episode-baseline.json", import.meta.url),
        "utf8"
      )
    )
  )

const databases: Database[] = []
const registries = new Map<string, Registry>()
let dir: string
let receipts: FileReceiptStore
beforeAll(async () => {
  await buildPatternFixtures()
  await buildContextFixtures()
  dir = await temporaryDir("analytics-episode-parity-")
  receipts = new FileReceiptStore(dir)
  for (const [name, connection] of Object.entries({
    samples: samplesConnection(),
    patterns: patternFixtureConnection(),
    precursors: precursorConnection(),
  })) {
    const db = createDatabase(connection)
    databases.push(db)
    registries.set(
      name,
      createRegistry({
        db,
        receipts,
        log: () => undefined,
      })
    )
  }
})
afterAll(async () => {
  await Promise.all(databases.map((db) => db.dispose()))
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

// Captured before changing lag SQL. Includes every fact's value, metadata,
// order and local ID; only the random receipt prefix is normalized.
it.each(baseline.cases)("lag parity: $name", async (fixture) => {
  const registry = registries.get(fixture.database)
  if (registry === undefined) throw new Error("missing fixture registry")
  const outcome = await registry.runTool(fixture.tool, fixture.input, {
    client: "test",
    signal: new AbortController().signal,
  })
  if (!outcome.ok) throw new Error(outcome.error.message)
  expect(outcome.result.receipt.result_digest).toBe(fixture.result_digest)
  expect(resultDigest(outcome.result.data)).toBe(fixture.result_digest)
  const receipt = await receipts.get(outcome.result.receipt.receipt_id)
  expect(receipt?.sql.some((sql) => sql.includes("MATCH_RECOGNIZE"))).toBe(true)
  const facts = outcome.result.facts.map((fact) => ({
    ...fact,
    id: fact.id.replace(/^r_[0-9a-f]+\./, ""),
  }))
  expect(resultDigest(facts)).toBe(fixture.facts_sha256)
})
