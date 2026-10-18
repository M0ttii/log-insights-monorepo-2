import type { Client } from "pg"
import { afterAll, beforeAll, expect, it } from "vitest"

import { loadConfig } from "../../gate/config.ts"
import { connect, type Db } from "../../gate/db.ts"
import { g13OtelCounts } from "../../gate/probes/g13-otel-counts.ts"
import { closeIfOpen, loadEnv } from "./helpers.ts"

loadEnv()
let db: Db
let client: Client | undefined
beforeAll(async () => {
  db = await connect(loadConfig())
  client = db.client
})
afterAll(async () => closeIfOpen(client))

it("checks the G13 dictionary plan and ns coercion without network fixtures", async () => {
  const checks = await g13OtelCounts.run({
    db,
    config: loadConfig(),
    bglLog: null,
    loadBgl: async () => null,
  })
  const results = checks.filter((entry) => "ok" in entry)
  expect(results.length).toBeGreaterThanOrEqual(7)
  for (const result of results) {
    expect(result.ok, `${result.name}: ${result.observed}`).toBe(true)
  }
})
