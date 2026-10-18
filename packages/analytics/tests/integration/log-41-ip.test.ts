/** Native SereneDB IP regression fixtures; expected entities are hand-authored. */
import { rm } from "node:fs/promises"

import { countEventsOutputSchema } from "@workspace/domain/tools/count-events"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import {
  buildFixtureDatabase,
  fixtureConnection,
  type FixtureRow,
} from "./fixtures.ts"
import { loadEnv, temporaryDir } from "./helpers.ts"

loadEnv()
const DATABASE = "log_insights_log41_ip"
const messages = [
  "std::bad_alloc std::bad_cast 1:2:3:4:5:6:7:8:9 256.0.0.1 1::2::3",
  "::ffff:192.0.2.128 ::ffff:192.0.2.128",
  "2001:DB8:0:0:0:0:0:1",
  "2001:db8::1",
  "[::1], (192.0.2.1); '255.255.255.255' address=198.51.100.2.",
  "structured only",
  "invalid structured only",
  "prefix192.0.2.1 192.0.2.1suffix 1.2.3.4.5 10.0.0.1.. 2001:db8::1%eth0",
  "[::]",
  "::ffff:192.0.2.128",
]
const rows: FixtureRow[] = messages.map((message, index) => ({
  event_id: index + 1,
  dataset: "openstack",
  ts: "2017-05-14T10:00:00Z",
  level: "INFO",
  component: "nova-api",
  message,
}))
let db: Database
let registry: Registry
let directory: string
const call = () => ({
  client: "test" as const,
  signal: new AbortController().signal,
})

beforeAll(async () => {
  await buildFixtureDatabase(DATABASE, rows)
  db = createDatabase(fixtureConnection(DATABASE))
  for (const [id, value] of [
    [2, "::ffff:192.0.2.128"],
    [6, "203.0.113.7"],
    [7, "std::bad_alloc"],
  ]) {
    await db.query(
      "UPDATE log_events SET client_ip=$1::VARCHAR WHERE event_id=$2::BIGINT",
      [value, id],
      call().signal
    )
  }
  directory = await temporaryDir("log41-ip-")
  registry = createRegistry({
    db,
    receipts: new FileReceiptStore(directory),
    log: () => undefined,
  })
})

afterAll(async () => {
  if (db !== undefined) await db.dispose()
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true })
})

async function distribution(value?: string) {
  const result = await registry.runTool(
    "count_events",
    {
      dataset: "openstack",
      group_by: ["component"],
      entity: { type: "ip", ...(value === undefined ? {} : { value }) },
    },
    call()
  )
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return countEventsOutputSchema.parse(result.result.data).entity_distribution
}

describe("LOG-41 complete native IP entities", () => {
  it("preserves mapped, full and compressed spelling and deduplicates raw/structured values", async () => {
    const actual = await distribution()
    expect(actual).toMatchObject({
      total_events: 10,
      matched_events: 7,
      occurrences: 10,
      distinct_entities: 9,
      truncated: false,
      other: null,
    })
    expect(actual?.groups).toEqual([
      { entity: "::ffff:192.0.2.128", events: 2, share: 0.2 },
      { entity: "192.0.2.1", events: 1, share: 0.1 },
      { entity: "198.51.100.2", events: 1, share: 0.1 },
      { entity: "2001:DB8:0:0:0:0:0:1", events: 1, share: 0.1 },
      { entity: "2001:db8::1", events: 1, share: 0.1 },
      { entity: "203.0.113.7", events: 1, share: 0.1 },
      { entity: "255.255.255.255", events: 1, share: 0.1 },
      { entity: "::", events: 1, share: 0.1 },
      { entity: "::1", events: 1, share: 0.1 },
    ])
  })

  it("does not emit valid prefixes/suffixes of malformed or non-IP tokens", async () => {
    for (const value of [
      "d::bad",
      "::ffff:192",
      "1:2:3:4:5:6:7:8",
      "256.0.0.1",
      "10.0.0.1",
      "std::bad_alloc",
    ]) {
      expect(await distribution(value)).toMatchObject({
        matched_events: 0,
        occurrences: 0,
        distinct_entities: 0,
        groups: [],
      })
    }
  })
})
