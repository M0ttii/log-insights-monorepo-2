import type { Client } from "pg"
import { afterAll, beforeAll, expect, it } from "vitest"

import { loadConfig } from "../../gate/config.ts"
import { connect, type Db } from "../../gate/db.ts"
import { g14Research } from "../../gate/probes/g14-research.ts"
import { closeIfOpen, loadEnv } from "./helpers.ts"

loadEnv()
let db: Db
let client: Client | undefined

beforeAll(async () => {
  db = await connect(loadConfig())
  client = db.client
})
afterAll(async () => closeIfOpen(client))

it("gates real vector retrieval, RRF and explicit provider absence without external calls", async () => {
  const checks = await g14Research.run({
    db,
    config: loadConfig(),
    bglLog: null,
    loadBgl: async () => null,
  })
  const assertions = checks.filter((entry) => "ok" in entry)
  expect(assertions.length).toBeGreaterThanOrEqual(6)
  for (const entry of assertions) {
    expect(entry.ok, `${entry.name}: ${entry.observed}`).toBe(true)
  }
})
