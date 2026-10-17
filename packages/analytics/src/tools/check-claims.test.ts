import type { Fact } from "@workspace/domain/facts"
import type { Receipt } from "@workspace/domain/receipt"
import {
  READ_ONLY_ANNOTATIONS,
  type ReceiptStore,
} from "@workspace/domain/tool"
import { describe, expect, it } from "vitest"

import { createRegistry } from "../registry.ts"
import { checkClaims } from "./check-claims.ts"

const MANIFEST_SQL = "SELECT data_version FROM load_manifest"
const NOW = "2026-10-17T12:00:00.000Z"
const RECEIPT = "r_7f3a9c21"
const OTHER = "r_0badc0de"
const HASH = "0".repeat(64)

/** Facts as count_events and describe_corpus write them; values set by hand. */
const FACTS: Fact[] = [
  {
    id: `${RECEIPT}.f1`,
    path: "/result/total",
    value: 4_747_963,
    metric: "events",
    unit: "log_events",
    group: {},
  },
  {
    id: `${RECEIPT}.f2`,
    path: "/result/groups/0/share",
    value: 0.375,
    metric: "share",
    unit: "ratio",
    group: { dataset: "bgl", team: "Compute Platform" },
  },
  {
    id: `${RECEIPT}.f3`,
    path: "/result/groups/0/requests",
    value: 120,
    metric: "requests",
    unit: "requests",
    group: { dataset: "openstack" },
  },
  {
    id: `${RECEIPT}.f4`,
    path: "/scope/windows/0/from",
    value: "2005-06-03T22:42:50.675872Z",
    metric: "window_start",
    unit: "utc_time",
    group: { dataset: "bgl" },
  },
]

const SCOPE: Receipt["scope"] = {
  windows: [
    {
      dataset: "bgl",
      from: "2005-06-03T22:42:50.675872Z",
      to: "2006-01-03T15:13:09.127919Z",
    },
  ],
  filters: { components: ["KERNEL"] },
}

function receipt(id: string, facts: Fact[]): Receipt {
  return {
    receipt_id: id,
    created_at: NOW,
    client: "mcp",
    tool: "count_events",
    tool_version: "1.1.0",
    input: { group_by: ["team"] },
    signature: HASH,
    data_version: "dv_0123456789abcdef",
    sql: ["SELECT 1"],
    params: [[]],
    scope: SCOPE,
    population: { count: 4_747_963, unit: "log_events" },
    rows_returned: 1,
    truncated: false,
    row_limit: 20,
    duration_ms: 1,
    result: {},
    result_digest: HASH,
    facts,
  }
}

function setup() {
  const files = new Map<string, Receipt>([
    [RECEIPT, receipt(RECEIPT, FACTS)],
    [OTHER, receipt(OTHER, [])],
  ])
  const reads: string[] = []
  const store: ReceiptStore = {
    async put(stored) {
      files.set(stored.receipt_id, stored)
    },
    async get(id) {
      reads.push(id)
      return files.get(id) ?? null
    },
    async list() {
      return [...files.keys()].toSorted()
    },
  }
  const sql: string[] = []
  const registry = createRegistry({
    db: {
      timeoutMs: 10_000,
      async query(text) {
        sql.push(text)
        if (text !== MANIFEST_SQL) throw new Error(`unexpected SQL: ${text}`)
        return { rows: [{ data_version: "dv_test" }], durationMs: 1 }
      },
    },
    receipts: store,
    clock: { now: () => NOW },
    log: () => undefined,
  })
  return { files, reads, registry, sql }
}

const call = { client: "test" as const, signal: new AbortController().signal }

async function check(
  registry: ReturnType<typeof setup>["registry"],
  claims: unknown[]
) {
  const outcome = await registry.runTool("check_claims", { claims }, call)
  if (!outcome.ok) throw new Error(outcome.error.message)
  return {
    ...outcome.result,
    data: checkClaims.output.parse(outcome.result.data),
  }
}

describe("check_claims", () => {
  it("checks each claim against its cited fact, in input order", async () => {
    const { registry } = setup()
    const { data } = await check(registry, [
      {
        fact: `${RECEIPT}.f1`,
        value: "4,747,963",
        metric: "events",
        group: {},
      },
      {
        fact: `${RECEIPT}.f2`,
        value: "37.5",
        unit: "percent",
        metric: "share",
        group: { dataset: "bgl", team: "Compute Platform" },
      },
      {
        fact: `${RECEIPT}.f3`,
        value: 120,
        metric: "errors",
        group: { dataset: "openstack" },
      },
      { fact: `${RECEIPT}.f9`, value: 1, metric: "events", group: {} },
      { fact: "r_ffffffff.f1", value: 1, metric: "events", group: {} },
      {
        fact: `${RECEIPT}.f4`,
        value: "2005-06-03T22:42Z",
        metric: "window_start",
        group: { dataset: "bgl" },
      },
    ])
    expect(data.claims.map((item) => [item.claim.fact, item.status])).toEqual([
      [`${RECEIPT}.f1`, "verified"],
      [`${RECEIPT}.f2`, "verified"],
      [`${RECEIPT}.f3`, "mismatch"],
      [`${RECEIPT}.f9`, "unknown_fact"],
      ["r_ffffffff.f1", "unknown_receipt"],
      [`${RECEIPT}.f4`, "verified"],
    ])
    expect(data.summary).toEqual({
      checked: 6,
      verified: 3,
      mismatch: 1,
      unresolved: 2,
      text: "6 claims checked · 1 mismatch · 2 unresolved",
    })
  })

  it("returns the cited fact with its receipt scope", async () => {
    const { registry } = setup()
    const { data } = await check(registry, [
      {
        fact: `${RECEIPT}.f3`,
        value: 120,
        metric: "errors",
        group: { dataset: "openstack" },
      },
    ])
    expect(data.claims[0]).toEqual({
      claim: {
        fact: `${RECEIPT}.f3`,
        value: 120,
        metric: "errors",
        group: { dataset: "openstack" },
      },
      status: "mismatch",
      mismatch_on: ["metric"],
      reason: 'metric: "errors" differs from the fact\'s metric "requests"',
      fact: {
        value: 120,
        metric: "requests",
        unit: "requests",
        group: { dataset: "openstack" },
      },
      receipt: {
        receipt_id: RECEIPT,
        tool: "count_events",
        data_version: "dv_0123456789abcdef",
        scope: SCOPE,
      },
    })
  })

  it("does not verify a value that only another fact holds", async () => {
    const { registry } = setup()
    const { data } = await check(registry, [
      // 120 is f3's value, not f1's.
      { fact: `${RECEIPT}.f1`, value: 120, metric: "events", group: {} },
    ])
    expect(data.claims[0]?.status).toBe("mismatch")
    expect(data.claims[0]?.mismatch_on).toEqual(["value"])
  })

  it("names the fact range of a known receipt and keeps its scope", async () => {
    const { registry } = setup()
    const { data } = await check(registry, [
      { fact: `${RECEIPT}.f9`, value: 1, metric: "events", group: {} },
      { fact: `${OTHER}.f1`, value: 1, metric: "events", group: {} },
    ])
    expect(data.claims.map((item) => item.reason)).toEqual([
      `receipt ${RECEIPT} (count_events) has facts f1–f4; cite an ID from its facts`,
      `receipt ${OTHER} (count_events) has no facts; cite an ID from its facts`,
    ])
    expect(data.claims[0]?.receipt?.scope).toEqual(SCOPE)
    expect(data.claims[0]?.fact).toBeNull()
  })

  it("treats a malformed ID as unknown_fact without touching the store", async () => {
    const { reads, registry } = setup()
    const { data } = await check(registry, [
      { fact: "../../etc/passwd", value: 1, metric: "events", group: {} },
      { fact: "r_7F3A9C21.f1", value: 1, metric: "events", group: {} },
      { fact: `${RECEIPT}.f0`, value: 1, metric: "events", group: {} },
      { fact: `${RECEIPT}.f01`, value: 1, metric: "events", group: {} },
      {
        fact: `${RECEIPT}.f1`,
        value: "4,747,963",
        metric: "events",
        group: {},
      },
    ])
    expect(data.claims.map((item) => item.status)).toEqual([
      "unknown_fact",
      "unknown_fact",
      "unknown_fact",
      "unknown_fact",
      "verified",
    ])
    expect(data.claims[0]?.reason).toMatch(
      /^"\.\.\/\.\.\/etc\/passwd" is not a fact ID/
    )
    expect(data.claims[0]?.receipt).toBeNull()
    expect(reads).toEqual([RECEIPT])
  })

  it("reads each receipt once per call", async () => {
    const { reads, registry } = setup()
    await check(registry, [
      { fact: `${RECEIPT}.f1`, value: 1, metric: "events", group: {} },
      { fact: `${RECEIPT}.f2`, value: 1, metric: "share", group: {} },
      { fact: `${RECEIPT}.f3`, value: 1, metric: "requests", group: {} },
      { fact: "r_ffffffff.f1", value: 1, metric: "events", group: {} },
      { fact: "r_ffffffff.f2", value: 1, metric: "events", group: {} },
    ])
    expect(reads.toSorted()).toEqual([RECEIPT, "r_ffffffff"])
  })

  it("writes its own receipt without SQL and with facts for the summary counts", async () => {
    const { files, registry, sql } = setup()
    const claims = [
      {
        fact: `${RECEIPT}.f1`,
        value: "4,747,963",
        metric: "events",
        group: {},
      },
      { fact: `${RECEIPT}.f9`, value: 1, metric: "events", group: {} },
    ]
    const result = await check(registry, claims)
    const id = result.receipt.receipt_id
    expect(result.receipt).toMatchObject({
      input: { claims },
      sql: [],
      params: [],
      scope: { windows: [], filters: {} },
      population: null,
      rows_returned: 2,
      truncated: false,
      duration_ms: 0,
    })
    expect(sql).toEqual([MANIFEST_SQL])
    expect(files.get(id)).toMatchObject({
      tool: "check_claims",
      row_limit: null,
      result: result.data,
    })
    expect(result.facts).toEqual(
      [
        // Keys in code-point order, like every fact list.
        ["checked", 2],
        ["mismatch", 0],
        ["unresolved", 1],
        ["verified", 1],
      ].map(([field, value], index) => ({
        id: `${id}.f${index + 1}`,
        path: `/result/summary/${field}`,
        value,
        metric: `claims_${field}`,
        unit: "claims",
        group: {},
      }))
    )
    expect(result.notes[0]).toMatch(/^Only the submitted claims were checked/)
  })

  it("can check the facts of its own receipts", async () => {
    const { registry } = setup()
    const first = await check(registry, [
      { fact: `${RECEIPT}.f1`, value: 1, metric: "events", group: {} },
    ])
    const second = await check(registry, [
      {
        fact: `${first.receipt.receipt_id}.f2`,
        value: 1,
        metric: "claims_mismatch",
        group: {},
      },
    ])
    expect(second.data.claims[0]?.status).toBe("verified")
  })

  it("rejects a missing group with the hint to pass {}", async () => {
    const { files, registry } = setup()
    const outcome = await registry.runTool(
      "check_claims",
      { claims: [{ fact: `${RECEIPT}.f1`, value: 1, metric: "events" }] },
      call
    )
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      message:
        "Invalid input at claims[0].group: Required: the group the text attributes the number to; pass {} for ungrouped facts.",
    })
    expect(files.size).toBe(2)
  })

  it("rejects more than 30 claims", async () => {
    const { registry } = setup()
    const claim = {
      fact: `${RECEIPT}.f1`,
      value: 1,
      metric: "events",
      group: {},
    }
    const outcome = await registry.runTool(
      "check_claims",
      { claims: Array.from({ length: 31 }, () => ({ ...claim })) },
      call
    )
    expect(outcome.ok ? null : outcome.error.code).toBe("invalid_input")
  })

  it("summarizes the line and every claim that is not verified", async () => {
    const { registry } = setup()
    const result = await check(registry, [
      {
        fact: `${RECEIPT}.f1`,
        value: "4,747,963",
        metric: "events",
        group: {},
      },
      {
        fact: `${RECEIPT}.f2`,
        value: "0.37",
        metric: "share",
        group: { dataset: "bgl", team: "Compute Platform" },
      },
      { fact: "r_ffffffff.f1", value: 1, metric: "events", group: {} },
    ])
    const entry = registry.tools.find((tool) => tool.name === "check_claims")
    const id = result.receipt.receipt_id
    expect(entry?.summarize(result)?.split("\n")).toEqual([
      `check_claims · receipt ${id}`,
      "3 claims checked · 1 mismatch · 1 unresolved",
      `Counts: checked 3 [${id}.f1], verified 1 [${id}.f4], mismatch 1 [${id}.f2], unresolved 1 [${id}.f3].`,
      "Not verified; correct or drop these claims:",
      `2. "${RECEIPT}.f2" mismatch on value: claimed "0.37" "share", group {"dataset":"bgl","team":"Compute Platform"}. value: 0.37 differs from the fact 0.375 rounded to 2 decimal places (0.38). Fact: 0.375 "share", group {"dataset":"bgl","team":"Compute Platform"}.`,
      '3. "r_ffffffff.f1" unknown_receipt: claimed 1 "events", group {}. no receipt r_ffffffff exists; cite fact IDs exactly as a tool returned them.',
      `Note: ${result.notes[0]}`,
      `Note: ${result.notes[1]}`,
    ])
  })

  it("is read-only, idempotent and closed-world like every default tool", () => {
    expect(checkClaims.annotations).toEqual(READ_ONLY_ANNOTATIONS)
  })
})
