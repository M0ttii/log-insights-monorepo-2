import { describe, expect, it } from "vitest"
import { z } from "zod"

import { toSafeInteger } from "./bigint.ts"
import { normalizeEndpoint } from "./endpoint.ts"
import {
  defineTool,
  READ_ONLY_ANNOTATIONS,
  renderDescription,
  type ToolDef,
} from "./tool.ts"

const base: ToolDef<{ n: number }, { n: number }> = {
  name: "echo_number",
  title: "Echo number",
  version: "1.0.0",
  description: "Test tool.",
  input: z.strictObject({ n: z.number() }),
  output: z.strictObject({ n: z.number() }),
  factSpecs: [],
  annotations: READ_ONLY_ANNOTATIONS,
  run: () => Promise.reject(new Error("not called")),
}

describe("defineTool", () => {
  it("accepts snake_case names up to 64 characters", () => {
    expect(defineTool(base).name).toBe("echo_number")
    expect(() =>
      defineTool({ ...base, name: `a${"b".repeat(63)}` })
    ).not.toThrow()
  })

  it("rejects other names and empty texts", () => {
    for (const name of [
      "Echo",
      "echo-number",
      "1echo",
      `a${"b".repeat(64)}`,
      "",
    ]) {
      expect(() => defineTool({ ...base, name })).toThrow(/invalid tool name/)
    }
    expect(() => defineTool({ ...base, description: " " })).toThrow(
      /needs a title and a description/
    )
  })
})

describe("READ_ONLY_ANNOTATIONS", () => {
  it("sets all four hints explicitly", () => {
    expect(READ_ONLY_ANNOTATIONS).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
  })
})

describe("renderDescription", () => {
  it("states every part in a fixed order", () => {
    expect(
      renderDescription({
        purpose: "Counts log events by group.",
        useWhen: "the question asks how often something happened.",
        doNotUseWhen: [
          { situation: "you need example lines", use: "search_logs" },
        ],
        inputs: "group_by (1–2 dimensions), top_n (1–50, default 20).",
        filters: "Accepted filters: dataset, from, to.",
        outputs: "total, groups with events and share, other.",
        truncation: "Groups beyond top_n are summed in other.",
        countingUnit: "log events (parsed lines), not incidents.",
      })
    ).toBe(
      [
        "Counts log events by group.",
        "Use when: the question asks how often something happened.",
        "Do not use when: you need example lines (use search_logs).",
        "Inputs: group_by (1–2 dimensions), top_n (1–50, default 20).",
        "Accepted filters: dataset, from, to.",
        "Output: total, groups with events and share, other.",
        "Truncation: Groups beyond top_n are summed in other.",
        "Counting unit: log events (parsed lines), not incidents.",
      ].join("\n")
    )
  })
})

describe("toSafeInteger", () => {
  it("converts exact integers within ±(2^53 − 1)", () => {
    expect(toSafeInteger("4747963")).toBe(4_747_963)
    expect(toSafeInteger("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER)
    expect(toSafeInteger(12n)).toBe(12)
    expect(toSafeInteger(-3)).toBe(-3)
  })

  it("refuses to round", () => {
    expect(() => toSafeInteger("9007199254740992")).toThrow(RangeError)
    expect(() => toSafeInteger("1.5")).toThrow(RangeError)
    expect(() => toSafeInteger(1.5)).toThrow(RangeError)
    expect(() => toSafeInteger("")).toThrow(RangeError)
  })
})

describe("normalizeEndpoint", () => {
  it("masks UUIDs, 32-hex IDs and numeric segments and drops the query", () => {
    expect(
      normalizeEndpoint(
        "/v2/54fadb412c4e40cdbaed9335e4c35a9e/servers/detail?limit=10"
      )
    ).toBe("/v2/<ID>/servers/detail")
    expect(
      normalizeEndpoint(
        "/v2/54fadb412c4e40cdbaed9335e4c35a9e/servers/3edec1e4-9678-4a3a-a21b-a145a4ee5e61"
      )
    ).toBe("/v2/<ID>/servers/<UUID>")
    expect(normalizeEndpoint("/openstack/2013-10-17/meta_data.json")).toBe(
      "/openstack/2013-10-17/meta_data.json"
    )
    expect(normalizeEndpoint("/latest/meta-data/")).toBe("/latest/meta-data/")
  })

  it("masks consecutive numeric segments", () => {
    expect(normalizeEndpoint("/a/1/2/b")).toBe("/a/<NUM>/<NUM>/b")
  })
})
