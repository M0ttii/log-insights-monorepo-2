import { describe, expect, it } from "vitest"
import { z } from "zod"

import { filterSchema, pickFilter, validateFilter } from "./filters.ts"

const window = { from: "2005-06-03T00:00:00Z", to: "2005-06-04T00:00:00Z" }

function issuePaths(filter: Parameters<typeof validateFilter>[0]): string[] {
  const error = validateFilter(filter)
  if (error === null) return []
  if (error.code !== "invalid_input")
    throw new Error(`unexpected ${error.code}`)
  return error.issues.map((issue) => issue.path)
}

describe("filterSchema", () => {
  it("accepts a full BGL filter", () => {
    const filter = {
      dataset: "bgl",
      ...window,
      components: ["KERNEL"],
      levels: ["FATAL", "FAILURE"],
      node: "R02-M1-N0-C:J12-U11",
      rack: "R02",
      only_errors: true,
      text: "machine check interrupt",
    }
    expect(filterSchema.parse(filter)).toEqual(filter)
  })

  it("requires a zone on times", () => {
    expect(
      filterSchema.safeParse({ from: "2005-06-03T00:00:00" }).success
    ).toBe(false)
    expect(
      filterSchema.safeParse({ from: "2005-06-03T02:00:00+02:00" }).success
    ).toBe(true)
  })

  it("rejects unknown fields instead of ignoring them", () => {
    expect(filterSchema.safeParse({ dataset: "bgl", host: "x" }).success).toBe(
      false
    )
  })

  it("bounds lists and text", () => {
    expect(
      filterSchema.safeParse({
        components: Array.from({ length: 21 }, (_, i) => `C${i}`),
      }).success
    ).toBe(false)
    expect(filterSchema.safeParse({ components: [] }).success).toBe(false)
    expect(filterSchema.safeParse({ text: "x".repeat(201) }).success).toBe(
      false
    )
    expect(filterSchema.safeParse({ text: "x".repeat(200) }).success).toBe(true)
    expect(filterSchema.safeParse({ levels: ["error"] }).success).toBe(false)
    expect(filterSchema.safeParse({ dataset: "hdfs" }).success).toBe(false)
  })
})

describe("validateFilter", () => {
  it("accepts a valid window", () => {
    expect(validateFilter({ dataset: "bgl", ...window })).toBeNull()
    expect(validateFilter({})).toBeNull()
  })

  it("requires from < to, compared as instants", () => {
    expect(issuePaths({ from: window.to, to: window.from })).toEqual(["to"])
    expect(issuePaths({ from: window.from, to: window.from })).toEqual(["to"])
    // Same instant written with an offset.
    expect(
      issuePaths({
        from: "2005-06-03T02:00:00+02:00",
        to: "2005-06-03T00:00:00Z",
      })
    ).toEqual(["to"])
  })

  it("rejects more than microsecond precision", () => {
    expect(issuePaths({ from: "2005-06-03T00:00:00.1234567Z" })).toEqual([
      "from",
    ])
  })

  it("rejects fields of the other dataset", () => {
    expect(
      issuePaths({
        dataset: "openstack",
        node: "R02-M1-N0-C:J12-U11",
        only_alerts: true,
      })
    ).toEqual(["node", "only_alerts"])
    expect(issuePaths({ dataset: "bgl", request_id: "req-1" })).toEqual([
      "request_id",
    ])
    expect(issuePaths({ rack: "R02", instance_id: "abc" })).toEqual([""])
  })
})

describe("pickFilter", () => {
  it("keeps declaration order and names the same fields in the summary", () => {
    const picked = pickFilter(["text", "dataset", "to", "from"])
    expect(picked.fields).toEqual(["dataset", "from", "to", "text"])
    expect(Object.keys(picked.shape)).toEqual(["dataset", "from", "to", "text"])
    expect(picked.summary).toBe(
      "Accepted filters: dataset, from, to, text. Other fields are rejected with invalid_input."
    )
  })

  it("builds strict tool inputs that reject unpicked filters", () => {
    const input = z.strictObject({
      ...pickFilter(["dataset", "from", "to"]).shape,
      limit: z.number(),
    })
    expect(input.safeParse({ dataset: "bgl", limit: 5 }).success).toBe(true)
    expect(
      input.safeParse({ dataset: "bgl", limit: 5, node: "x" }).success
    ).toBe(false)
  })
})
