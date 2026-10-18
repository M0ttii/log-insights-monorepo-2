import type { Client } from "pg"
import { afterAll, beforeAll, expect, it } from "vitest"

import { loadConfig } from "../../gate/config.ts"
import { connect, type Db } from "../../gate/db.ts"
import { g11MatchRecognize } from "../../gate/probes/g11-match-recognize.ts"
import { closeIfOpen, loadEnv } from "./helpers.ts"

loadEnv()
let db: Db
let client: Client | undefined

beforeAll(async () => {
  db = await connect(loadConfig())
  client = db.client
})
afterAll(async () => closeIfOpen(client))

it("passes G11 on the running 26.10.1 image", async () => {
  const checks = await g11MatchRecognize.run({
    db,
    config: loadConfig(),
    bglLog: null,
    loadBgl: async () => null,
  })
  expect(checks).toHaveLength(5)
  for (const check of checks) {
    if (!("ok" in check)) throw new Error("G11 must not skip a check")
    expect(check.ok, `${check.name}: ${check.observed}`).toBe(true)
  }
})
