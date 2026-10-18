/** Read-only bind regression against the CI-loaded OTel fixtures and replay. */
import { rm } from "node:fs/promises"

import { countEventsOutputSchema } from "@workspace/domain/tools/count-events"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import { loadEnv, otelSamplesConnection, temporaryDir } from "./helpers.ts"

loadEnv()
let db: Database
let registry: Registry
let directory: string
beforeAll(async () => {
  db = createDatabase(otelSamplesConnection())
  directory = await temporaryDir("log41-remote-entities-")
  registry = createRegistry({
    db,
    receipts: new FileReceiptStore(directory),
    log: () => undefined,
  })
})
afterAll(async () => {
  await db.dispose()
  await rm(directory, { recursive: true, force: true })
})

describe("OTel entity queries retain only their relation's bound parameters", () => {
  it.each([
    { dataset: "otel", type: "ip", text: undefined },
    { dataset: "otel", type: "path", text: undefined },
    { dataset: "otel", type: "ip", text: "Visa" },
    { dataset: "otel", type: "path", text: "Visa" },
    { dataset: "otel_replay", type: "ip", text: undefined },
    { dataset: "otel_replay", type: "path", text: undefined },
  ] as const)(
    "counts $dataset $type with text=$text",
    async ({ dataset, type, text }) => {
      const input = {
        dataset,
        group_by: ["component"],
        top_n: 2,
        entity: { type },
        ...(dataset === "otel"
          ? {
              from: "2025-09-23T00:29:24.037000Z",
              to: "2025-09-23T00:29:24.041000Z",
            }
          : {}),
        ...(text === undefined ? {} : { text }),
      }
      const outcome = await registry.runTool("count_events", input, {
        client: "test",
        signal: new AbortController().signal,
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok)
        throw new Error(`${outcome.error.code}: ${outcome.error.message}`)
      const data = countEventsOutputSchema.parse(outcome.result.data)
      expect(data.entity_distribution?.type).toBe(type)
      expect(data.entity_distribution?.total_events).toBe(data.total)
      expect(
        outcome.result.facts.some(
          (fact) =>
            fact.path === "/result/entity_distribution/total_events" &&
            fact.group.type === type
        )
      ).toBe(true)
    }
  )
})
