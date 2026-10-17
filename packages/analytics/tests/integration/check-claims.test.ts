/**
 * check_claims through the registry against receipts of real describe_corpus
 * and count_events runs on the Loghub 2k samples (`pnpm data:setup
 * --samples`), covering S-08 completely. The claimed values were determined
 * by hand from the raw sample files (see describe-corpus.test.ts and
 * count-events.test.ts): OpenStack has 928 distinct request IDs among its
 * 1,017 API accesses, BGL has 2,000 events, its first at
 * 2005-06-03T22:42:50.675872Z, and 1,820 of them are KERNEL events, a share
 * of 0.91.
 */
import { rm } from "node:fs/promises"

import { factSchema, type Fact } from "@workspace/domain/facts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import { checkClaims } from "../../src/tools/check-claims.ts"
import {
  loadEnv,
  runScript,
  samplesConnection,
  temporaryDir,
} from "./helpers.ts"

loadEnv()

let db: Database
let dir: string
let registry: Registry

beforeAll(async () => {
  db = createDatabase(samplesConnection())
  dir = await temporaryDir("analytics-claims-")
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

async function facts(tool: string, input: unknown): Promise<Fact[]> {
  const outcome = await registry.runTool(tool, input, call())
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.result.facts
}

/** The fact a model would cite: chosen by metric and group from the list. */
function pick(
  list: readonly Fact[],
  metric: string,
  group: Record<string, string>
): Fact {
  const found = list.find(
    (fact) =>
      fact.metric === metric &&
      JSON.stringify(fact.group) === JSON.stringify(group)
  )
  if (found === undefined) throw new Error(`no fact ${metric}`)
  return found
}

async function check(claims: unknown[], client: "mcp" | "web" = "mcp") {
  const outcome = await registry.runTool(
    "check_claims",
    { claims },
    call(client)
  )
  if (!outcome.ok) throw new Error(outcome.error.message)
  return checkClaims.output.parse(outcome.result.data)
}

describe("check_claims on describe_corpus facts (S-08)", () => {
  it("verifies the right value and catches wrong values, metrics, groups and IDs", async () => {
    const corpus = await facts("describe_corpus", {})
    const requests = pick(corpus, "requests", { dataset: "openstack" })
    const bglEvents = pick(corpus, "events", { dataset: "bgl" })
    const [receiptId] = requests.id.split(".")

    const { claims, summary } = await check([
      // Right value with separator.
      {
        fact: bglEvents.id,
        value: "2,000",
        metric: "events",
        group: { dataset: "bgl" },
      },
      // Right value, right metric and group.
      {
        fact: requests.id,
        value: 928,
        metric: "requests",
        group: { dataset: "openstack" },
      },
      // Wrong value.
      {
        fact: requests.id,
        value: "929",
        metric: "requests",
        group: { dataset: "openstack" },
      },
      // Right value under the wrong metric: 928 requests stated as errors.
      {
        fact: requests.id,
        value: 928,
        metric: "error_events",
        group: { dataset: "openstack" },
      },
      // Right value attributed to the wrong group.
      {
        fact: requests.id,
        value: 928,
        metric: "requests",
        group: { dataset: "bgl" },
      },
      // Unknown running number in a known receipt.
      {
        fact: `${receiptId}.f999`,
        value: 928,
        metric: "requests",
        group: { dataset: "openstack" },
      },
      // Unknown receipt.
      {
        fact: "r_00000000.f1",
        value: 928,
        metric: "requests",
        group: { dataset: "openstack" },
      },
    ])

    expect(claims.map((item) => [item.status, item.mismatch_on])).toEqual([
      ["verified", []],
      ["verified", []],
      ["mismatch", ["value"]],
      ["mismatch", ["metric"]],
      ["mismatch", ["group"]],
      ["unknown_fact", []],
      ["unknown_receipt", []],
    ])
    expect(summary).toEqual({
      checked: 7,
      verified: 2,
      mismatch: 3,
      unresolved: 2,
      text: "7 claims checked · 3 mismatch · 2 unresolved",
    })
    expect(claims[3]?.fact).toEqual({
      value: 928,
      metric: "requests",
      unit: "requests",
      group: { dataset: "openstack" },
    })
    expect(claims[3]?.receipt).toMatchObject({
      receipt_id: receiptId,
      tool: "describe_corpus",
      scope: { windows: [{ dataset: "bgl" }, { dataset: "openstack" }] },
    })
    expect(claims[5]?.reason).toBe(
      `receipt ${receiptId} (describe_corpus) has facts f1–f${corpus.length}; cite an ID from its facts`
    )
  })

  it("checks times as UTC prefixes", async () => {
    const corpus = await facts("describe_corpus", {})
    const first = pick(corpus, "first_event_time", { dataset: "bgl" })
    const claim = (value: string) => ({
      fact: first.id,
      value,
      metric: "first_event_time",
      group: { dataset: "bgl" },
    })
    const { claims } = await check([
      claim("2005-06-03"),
      claim("2005-06-03T22:42Z"),
      claim("2005-06-03T22:42:50.675872Z"),
      claim("2005-06-04"),
    ])
    expect(claims.map((item) => item.status)).toEqual([
      "verified",
      "verified",
      "verified",
      "mismatch",
    ])
  })
})

describe("check_claims on count_events facts", () => {
  it("compares shares as fraction or percent and the group as group_by", async () => {
    const counts = await facts("count_events", {
      dataset: "bgl",
      group_by: ["component"],
    })
    const total = pick(counts, "events", {})
    const kernel = pick(counts, "events", { component: "KERNEL" })
    const share = pick(counts, "share", { component: "KERNEL" })
    const group = { component: "KERNEL" }

    const { claims, summary } = await check(
      [
        { fact: total.id, value: "2,000", metric: "events", group: {} },
        { fact: kernel.id, value: "1,820", metric: "events", group },
        { fact: share.id, value: 0.91, metric: "share", group },
        {
          fact: share.id,
          value: "91",
          unit: "percent",
          metric: "share",
          group,
        },
        {
          fact: share.id,
          value: "91.0",
          unit: "percent",
          metric: "share",
          group,
        },
        // 91 without the unit is not the fraction 0.91.
        { fact: share.id, value: "91", metric: "share", group },
        {
          fact: share.id,
          value: "90",
          unit: "percent",
          metric: "share",
          group,
        },
        // The group of a count_events fact is its group_by dimensions only.
        {
          fact: kernel.id,
          value: "1,820",
          metric: "events",
          group: { dataset: "bgl", component: "KERNEL" },
        },
        // 1,820 is a fact of this receipt, but not the total.
        { fact: total.id, value: "1,820", metric: "events", group: {} },
      ],
      "web"
    )
    expect(claims.map((item) => item.status)).toEqual([
      "verified",
      "verified",
      "verified",
      "verified",
      "verified",
      "mismatch",
      "mismatch",
      "mismatch",
      "mismatch",
    ])
    expect(claims[7]?.mismatch_on).toEqual(["group"])
    expect(claims[8]?.mismatch_on).toEqual(["value"])
    expect(summary.text).toBe("9 claims checked · 4 mismatch · 0 unresolved")
  })
})

describe("check_claims across processes", () => {
  it("checks receipts that other processes just wrote", async () => {
    const outputs = await Promise.all(
      [1, 2, 3].map(() => runScript("print-facts.ts", [dir], "UTC"))
    )
    const printed = z.object({
      receipt_id: z.string(),
      facts: z.array(factSchema),
    })
    const written = outputs.map((output) => printed.parse(JSON.parse(output)))
    expect(new Set(written.map((run) => run.receipt_id)).size).toBe(3)
    const { claims, summary } = await check(
      written.map((run) => ({
        fact: pick(run.facts, "requests", { dataset: "openstack" }).id,
        value: 928,
        metric: "requests",
        group: { dataset: "openstack" },
      }))
    )
    expect(claims.map((item) => item.receipt?.receipt_id)).toEqual(
      written.map((run) => run.receipt_id)
    )
    expect(summary.text).toBe("3 claims checked · 0 mismatch · 0 unresolved")
  })
})
