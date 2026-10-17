/**
 * describe_corpus through the registry against SereneDB with the Loghub 2k
 * samples (`pnpm data:setup --samples`). Expected values were determined by
 * hand from the raw sample files (awk over BGL_2k.log and OpenStack_2k.log,
 * `date -u -r` for the Unix seconds), not from the loader or the tool.
 */
import { existsSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"

import type { Receipt } from "@workspace/domain/receipt"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { getDataSpan } from "../../src/corpus.ts"
import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import { describeCorpus as tool } from "../../src/tools/describe-corpus.ts"
import {
  loadEnv,
  runScript,
  samplesConnection,
  temporaryDir,
} from "./helpers.ts"

loadEnv()

const BGL_FIRST = "2005-06-03T22:42:50.675872Z"
const BGL_LAST = "2006-01-03T15:13:09.127918Z"
const OPENSTACK_FIRST = "2017-05-16T00:00:00.008000Z"
const OPENSTACK_LAST = "2017-05-16T00:14:47.687000Z"

let db: Database
let dir: string
let registry: Registry

beforeAll(async () => {
  db = createDatabase(samplesConnection())
  dir = await temporaryDir("analytics-describe-")
  registry = createRegistry({
    db,
    receipts: new FileReceiptStore(dir),
    log: () => undefined,
  })
})

afterAll(async () => {
  await db.dispose()
  await rm(dir, { recursive: true, force: true })
})

const call = (client: "mcp" | "web" | "test" = "test") => ({
  client,
  signal: new AbortController().signal,
})

async function describeCorpus(client: "mcp" | "web" | "test" = "test") {
  const outcome = await registry.runTool("describe_corpus", {}, call(client))
  if (!outcome.ok) throw new Error(outcome.error.message)
  return { ...outcome.result, data: tool.output.parse(outcome.result.data) }
}

/** RFC 6901 pointer into the receipt. */
function resolve(receipt: Receipt, pointer: string): unknown {
  let value: unknown = receipt
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~")
    if (Array.isArray(value)) value = value[Number(key)]
    else if (typeof value === "object" && value !== null)
      value = Object.getOwnPropertyDescriptor(value, key)?.value
    else return undefined
  }
  return value
}

describe("describe_corpus", () => {
  it("returns the per-dataset figures of the samples", async () => {
    const { data } = await describeCorpus()
    expect(data).toMatchObject({
      datasets: [
        {
          dataset: "bgl",
          events: 2000,
          lines_read: 2000,
          rejected: 0,
          first_event: BGL_FIRST,
          last_event: BGL_LAST,
          error_events: 395,
          levels: [
            { level: "INFO", events: 1597 },
            { level: "FATAL", events: 347 },
            { level: "ERROR", events: 41 },
            { level: "WARNING", events: 8 },
            { level: "SEVERE", events: 7 },
          ],
          components: [
            { component: "KERNEL", team: "Compute Platform", events: 1820 },
            { component: "APP", team: "Workload Runtime", events: 107 },
            { component: "DISCOVERY", team: "Hardware Operations", events: 35 },
            { component: "MMCS", team: "Control Plane", events: 35 },
            { component: "HARDWARE", team: "Hardware Operations", events: 3 },
          ],
          api_accesses: null,
          api_accesses_without_request_id: null,
          requests: null,
        },
        {
          dataset: "openstack",
          events: 2000,
          lines_read: 2000,
          rejected: 0,
          first_event: OPENSTACK_FIRST,
          last_event: OPENSTACK_LAST,
          error_events: 0,
          levels: [
            { level: "INFO", events: 1969 },
            { level: "WARNING", events: 31 },
          ],
          components: [
            { component: "nova-api", team: "API Gateway", events: 1060 },
            {
              component: "nova-compute",
              team: "Compute Platform",
              events: 933,
            },
            { component: "nova-scheduler", team: "Control Plane", events: 7 },
          ],
          api_accesses: 1017,
          api_accesses_without_request_id: 89,
          requests: 928,
        },
      ],
      ownership: {
        fictional: true,
        unowned: [],
      },
      versions: { source: "samples" },
      answer_guidance: null,
      guidance_version: null,
    })
    expect(data.datasets[0]?.labels.slice(0, 3)).toEqual([
      { label: null, events: 1857 },
      { label: "KERNDTLB", events: 60 },
      { label: "KERNSTOR", events: 30 },
    ])
    expect(data.ownership.teams.map((team) => team.team)).toEqual([
      "API Gateway",
      "Compute Platform",
      "Control Plane",
      "Hardware Operations",
      "Workload Runtime",
    ])
    expect(data.limits).toHaveLength(4)
  })

  it("stores a receipt with exact SQL, data version, scope and duration", async () => {
    const result = await describeCorpus()
    const { receipt } = result
    const file = join(dir, `${receipt.receipt_id}.json`)
    expect(existsSync(file)).toBe(true)
    const stored: Receipt = JSON.parse(await readFile(file, "utf8"))
    expect(stored.result).toEqual(result.data)
    expect(stored.facts).toEqual(result.facts)
    expect(receipt.sql).toHaveLength(3)
    expect(receipt.sql[0]).toMatch(/^SELECT dataset, lines_read, events/)
    expect(receipt.params).toEqual([[], [], []])
    expect(receipt.data_version).toMatch(/^dv_[0-9a-f]{16}$/)
    expect(result.data.versions.data_version).toBe(receipt.data_version)
    expect(receipt.duration_ms).toBeGreaterThan(0)
    expect(receipt.scope).toEqual({
      windows: [
        { dataset: "bgl", from: BGL_FIRST, to: "2006-01-03T15:13:09.127919Z" },
        {
          dataset: "openstack",
          from: OPENSTACK_FIRST,
          to: "2017-05-16T00:14:47.687001Z",
        },
      ],
      filters: {},
    })
    expect(receipt.population).toEqual({ count: 4000, unit: "log_events" })
    expect(result.notes).toContain(
      "Counts are log events (parsed lines), not incidents or outages."
    )
  })

  it("lists facts whose paths resolve to their values in the receipt", async () => {
    const { receipt, facts } = await describeCorpus()
    const stored = await new FileReceiptStore(dir).get(receipt.receipt_id)
    if (stored === null) throw new Error("receipt missing")
    expect(facts).toHaveLength(30)
    facts.forEach((fact, index) => {
      expect(fact.id).toBe(`${receipt.receipt_id}.f${index + 1}`)
      expect(resolve(stored, fact.path)).toBe(fact.value)
    })
    expect(facts.find((fact) => fact.metric === "requests")).toMatchObject({
      value: 928,
      unit: "requests",
      group: { dataset: "openstack" },
    })
    expect(
      facts.find(
        (fact) => fact.path === "/result/datasets/0/components/0/events"
      )
    ).toMatchObject({
      value: 1820,
      group: { dataset: "bgl", team: "Compute Platform", component: "KERNEL" },
    })
  })

  it("reruns with the same signature, data version and digest from another client (S-12)", async () => {
    const first = await describeCorpus("mcp")
    const web = await describeCorpus("web")
    expect(web.receipt.signature).toBe(first.receipt.signature)
    const rerun = await registry.rerun(first.receipt.receipt_id, call("web"))
    expect(rerun.ok ? rerun.matches : rerun.error).toEqual({
      signature: true,
      data_version: true,
      result_digest: true,
    })
  })

  it("keeps microseconds identical in every process time zone", async () => {
    const outputs = await Promise.all(
      ["UTC", "America/Los_Angeles", "Asia/Kolkata"].map((zone) =>
        runScript("print-times.ts", [dir], zone)
      )
    )
    const parsed = outputs.map((output) => JSON.parse(output))
    expect(parsed[1]).toEqual(parsed[0])
    expect(parsed[2]).toEqual(parsed[0])
    expect(
      parsed[0].facts.map((fact: { value: string }) => fact.value)
    ).toEqual([BGL_FIRST, BGL_LAST, OPENSTACK_FIRST, OPENSTACK_LAST])
  })
})

describe("getDataSpan", () => {
  it("reads the span from corpus_stats", async () => {
    const signal = new AbortController().signal
    expect(await getDataSpan(db, "bgl", signal)).toEqual({
      first: BGL_FIRST,
      last: BGL_LAST,
    })
    expect(await getDataSpan(db, "openstack", signal)).toEqual({
      first: OPENSTACK_FIRST,
      last: OPENSTACK_LAST,
    })
  })
})
