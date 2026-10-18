import type { Client } from "pg"
import { afterAll, beforeAll, expect, it } from "vitest"

import { loadConfig } from "../../gate/config.ts"
import { connect, type Db } from "../../gate/db.ts"
import { g12IndexFunctions } from "../../gate/probes/g12-index-functions.ts"
import { closeIfOpen, loadEnv } from "./helpers.ts"

loadEnv()
let db: Db
let client: Client | undefined

beforeAll(async () => {
  db = await connect(loadConfig())
  client = db.client
})
afterAll(async () => closeIfOpen(client))

it("passes U25 semantics on the running 26.10.1 image without corpus files", async () => {
  const checks = await g12IndexFunctions.run({
    db,
    config: loadConfig(),
    bglLog: null,
    loadBgl: async () => null,
  })
  expect(checks.length).toBeGreaterThan(30)
  for (const check of checks) {
    if (!("ok" in check)) throw new Error("G12 must not skip a check")
    expect(check.ok, `${check.name}: ${check.observed}`).toBe(true)
  }
})
