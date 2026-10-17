import { describe, expect, it } from "vitest"

import { factId, parseFactId } from "./ids.ts"
import {
  canonicalJson,
  receiptSchema,
  receiptSummarySchema,
  signaturePayload,
  type Receipt,
} from "./receipt.ts"

const HEX64 = "a".repeat(64)

const receipt: Receipt = {
  receipt_id: "r_7f3a9c21",
  created_at: "2026-10-17T12:00:00.000000Z",
  client: "test",
  tool: "count_events",
  tool_version: "1.0.0",
  input: { dataset: "bgl", group_by: ["team"] },
  signature: HEX64,
  data_version: "dv_1",
  sql: ["SELECT count(*) FROM log_events WHERE dataset = $1"],
  params: [["bgl"]],
  scope: {
    windows: [
      {
        dataset: "bgl",
        from: "2005-06-03T22:42:50.363779Z",
        to: "2006-01-04T16:00:05.233640Z",
      },
    ],
    filters: { only_errors: true },
  },
  population: { count: 4_747_963, unit: "log_events" },
  rows_returned: 1,
  truncated: false,
  row_limit: 20,
  duration_ms: 12.5,
  result: { total: 4_747_963 },
  result_digest: HEX64,
  facts: [
    {
      id: "r_7f3a9c21.f1",
      path: "/result/total",
      value: 4_747_963,
      metric: "events",
      unit: "log_events",
      group: {},
    },
  ],
}

describe("receiptSchema", () => {
  it("accepts a complete receipt and derives the summary", () => {
    expect(receiptSchema.parse(receipt)).toEqual(receipt)
    const fullOnly = new Set([
      "client",
      "created_at",
      "tool",
      "tool_version",
      "row_limit",
      "result",
      "facts",
    ])
    const summary = receiptSummarySchema.parse(
      Object.fromEntries(
        Object.entries(receipt).filter(([key]) => !fullOnly.has(key))
      )
    )
    expect(Object.keys(summary).toSorted()).toEqual(
      [
        "data_version",
        "duration_ms",
        "input",
        "params",
        "population",
        "receipt_id",
        "result_digest",
        "rows_returned",
        "scope",
        "signature",
        "sql",
        "truncated",
      ].toSorted()
    )
  })

  it("rejects malformed IDs, unknown counting units and extra fields", () => {
    expect(
      receiptSchema.safeParse({ ...receipt, receipt_id: "r_7F3A9C21" }).success
    ).toBe(false)
    expect(
      receiptSchema.safeParse({
        ...receipt,
        population: { count: 1, unit: "lines" },
      }).success
    ).toBe(false)
    expect(receiptSchema.safeParse({ ...receipt, extra: 1 }).success).toBe(
      false
    )
    expect(
      receiptSchema.safeParse({ ...receipt, population: null }).success
    ).toBe(true)
  })
})

describe("canonicalJson", () => {
  it("sorts keys at every level and drops undefined properties", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [1, "x", null], c: true }, u: undefined })
    ).toBe('{"a":{"c":true,"d":[1,"x",null]},"b":1}')
  })

  it("is independent of construction order", () => {
    expect(canonicalJson({ x: 1, y: { p: 1, q: 2 } })).toBe(
      canonicalJson({ y: { q: 2, p: 1 }, x: 1 })
    )
  })

  it("throws on values JSON cannot represent exactly", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError)
    expect(() => canonicalJson([undefined])).toThrow(TypeError)
    expect(() => canonicalJson(1n)).toThrow(TypeError)
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(TypeError)
  })

  it("feeds the signature with tool, version and input", () => {
    expect(
      signaturePayload("count_events", "1.0.0", { top_n: 20, dataset: "bgl" })
    ).toBe(
      '{"input":{"dataset":"bgl","top_n":20},"tool":"count_events","tool_version":"1.0.0"}'
    )
  })
})

describe("fact IDs", () => {
  it("round-trip receipt and running number", () => {
    expect(factId("r_7f3a9c21", 4)).toBe("r_7f3a9c21.f4")
    expect(parseFactId("r_7f3a9c21.f4")).toEqual({
      receiptId: "r_7f3a9c21",
      index: 4,
    })
    expect(parseFactId("r_7f3a9c21.f12")).toEqual({
      receiptId: "r_7f3a9c21",
      index: 12,
    })
  })

  it("reject malformed IDs", () => {
    for (const id of [
      "r_7f3a9c21.f0",
      "r_7f3a9c21.f01",
      "r_7f3a9c2.f1",
      "r_7f3a9c21",
      "/result/total",
    ]) {
      expect(parseFactId(id)).toBeNull()
    }
    expect(() => factId("r_7f3a9c21", 0)).toThrow(RangeError)
    expect(() => factId("7f3a9c21", 1)).toThrow(RangeError)
  })
})
