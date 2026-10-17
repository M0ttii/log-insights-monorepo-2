import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  countEventsFactSpecs,
  countEventsInputSchema,
  countEventsOutputSchema,
  countGroupSchema,
  countsApiAccesses,
} from "./count-events.ts"

const parse = (input: unknown) => countEventsInputSchema.safeParse(input)

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("not an object")
  return Object.fromEntries(Object.entries(value))
}

describe("countEventsInputSchema", () => {
  it("resolves the default top_n", () => {
    expect(countEventsInputSchema.parse({ group_by: ["team"] })).toEqual({
      group_by: ["team"],
      top_n: 20,
    })
  })

  it("takes 1–2 known dimensions and top_n 1–50", () => {
    expect(parse({ group_by: [] }).success).toBe(false)
    expect(parse({ group_by: ["dataset", "team", "level"] }).success).toBe(
      false
    )
    expect(parse({ group_by: ["message"] }).success).toBe(false)
    expect(parse({}).success).toBe(false)
    expect(parse({ group_by: ["dataset", "team"] }).success).toBe(true)
    expect(parse({ group_by: ["level"], top_n: 0 }).success).toBe(false)
    expect(parse({ group_by: ["level"], top_n: 51 }).success).toBe(false)
    expect(parse({ group_by: ["level"], top_n: 50 }).success).toBe(true)
  })

  it("accepts every shared filter and rejects unknown fields", () => {
    expect(
      parse({
        group_by: ["component"],
        text: "cache parity",
        pattern_id: "0123456789abcdef",
        only_errors: true,
      }).success
    ).toBe(true)
    expect(parse({ group_by: ["component"], foo: 1 }).success).toBe(false)
  })

  it("exports a strict JSON Schema with a description on every field", () => {
    for (const [schema, io] of [
      [countEventsInputSchema, "input"],
      [countEventsOutputSchema, "output"],
      [countGroupSchema, "output"],
    ] as const) {
      const json = z.toJSONSchema(schema, { io })
      expect(json.additionalProperties).toBe(false)
      const undescribed = Object.entries(asObject(json.properties))
        .filter(
          ([, property]) => typeof asObject(property).description !== "string"
        )
        .map(([name]) => name)
      expect(undescribed).toEqual([])
    }
    const input = z.toJSONSchema(countEventsInputSchema, { io: "input" })
    expect(input.required).toEqual(["group_by"])
    expect(asObject(asObject(input.properties).group_by)).toMatchObject({
      minItems: 1,
      maxItems: 2,
    })
  })
})

describe("countEventsFactSpecs", () => {
  it("groups facts by the group_by dimensions", () => {
    const specs = countEventsFactSpecs({ group_by: ["dataset", "team"] })
    expect(specs.find((s) => s.path === "/result/groups/*/events")).toEqual({
      path: "/result/groups/*/events",
      metric: "events",
      unit: "log_events",
      groupKeys: ["dataset", "team"],
    })
    expect(specs.find((s) => s.path === "/result/total")).toMatchObject({
      metric: "events",
      groupKeys: [],
    })
  })

  it("names API accesses as metric and unit for http_status and endpoint", () => {
    expect(countsApiAccesses(["component", "endpoint"])).toBe(true)
    expect(countsApiAccesses(["component", "node"])).toBe(false)
    const specs = countEventsFactSpecs({ group_by: ["http_status"] })
    expect(
      specs
        .filter((s) => s.path.includes("events") || s.path === "/result/total")
        .map((s) => [s.path, s.metric, s.unit])
    ).toEqual([
      ["/result/total", "api_accesses", "api_accesses"],
      ["/result/groups/*/events", "api_accesses", "api_accesses"],
      ["/result/other/events", "other_api_accesses", "api_accesses"],
    ])
  })
})
