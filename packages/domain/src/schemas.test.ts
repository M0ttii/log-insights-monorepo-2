import { describe, expect, it } from "vitest"
import { z } from "zod"

import { toolErrorSchema } from "./errors.ts"
import { factSchema, factSpecSchema } from "./facts.ts"
import { filterSchema, pickFilter } from "./filters.ts"
import { receiptSchema } from "./receipt.ts"
import { changeLabelSchema } from "./rules/compare.ts"
import { dominanceSchema, priorityDominanceSchema } from "./rules/dominance.ts"
import { leaderSchema, rankCriterionSchema } from "./rules/ranking.ts"
import { patternStatusSchema } from "./rules/status.ts"
import { emptyInputSchema, toolResultSchema } from "./tool.ts"
import {
  checkClaimsInputSchema,
  checkClaimsOutputSchema,
} from "./tools/check-claims.ts"
import {
  countEventsInputSchema,
  countEventsOutputSchema,
} from "./tools/count-events.ts"
import {
  eventTrendInputSchema,
  eventTrendOutputSchema,
} from "./tools/event-trend.ts"
import {
  getLogContextInputSchema,
  getLogContextOutputSchema,
} from "./tools/get-log-context.ts"
import {
  recurringPatternsInputSchema,
  recurringPatternsOutputSchema,
} from "./tools/recurring-patterns.ts"
import {
  searchLogsInputSchema,
  searchLogsOutputSchema,
} from "./tools/search-logs.ts"

/**
 * MCP and the AI SDK see these schemas as JSON Schema 2020-12. The snapshots
 * pin the exported form; the explicit checks guard what must never get lost:
 * strictness, limits and descriptions.
 */

const exampleInput = z.strictObject({
  ...pickFilter(["dataset", "from", "to", "components", "text"]).shape,
  top_n: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Groups to return (1–50). Default: 20."),
})

const schemas = {
  filter: filterSchema,
  exampleInput,
  emptyInput: emptyInputSchema,
  exampleResult: toolResultSchema(z.strictObject({ total: z.number().int() })),
  receipt: receiptSchema,
  toolError: toolErrorSchema,
  fact: factSchema,
  factSpec: factSpecSchema,
  changeLabel: changeLabelSchema,
  patternStatus: patternStatusSchema,
  rankCriterion: rankCriterionSchema,
  dominance: dominanceSchema,
  priorityDominance: priorityDominanceSchema,
  leader: leaderSchema,
  searchLogsInput: searchLogsInputSchema,
  searchLogsOutput: searchLogsOutputSchema,
  countEventsInput: countEventsInputSchema,
  countEventsOutput: countEventsOutputSchema,
  eventTrendInput: eventTrendInputSchema,
  eventTrendOutput: eventTrendOutputSchema,
  recurringPatternsInput: recurringPatternsInputSchema,
  recurringPatternsOutput: recurringPatternsOutputSchema,
  getLogContextInput: getLogContextInputSchema,
  getLogContextOutput: getLogContextOutputSchema,
  checkClaimsInput: checkClaimsInputSchema,
  checkClaimsOutput: checkClaimsOutputSchema,
}

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("not an object")
  return Object.fromEntries(Object.entries(value))
}

function property(schema: unknown, ...path: string[]): JsonObject {
  let node = asObject(schema)
  for (const key of path) node = asObject(asObject(node.properties)[key])
  return node
}

describe("JSON Schema export", () => {
  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name} converts losslessly for input and output`, () => {
      const input = z.toJSONSchema(schema, { io: "input" })
      const output = z.toJSONSchema(schema, { io: "output" })
      expect(input.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
      expect({ input, output }).toMatchSnapshot()
    })
  }

  it("keeps tool inputs strict in the form MCP reads (io: input)", () => {
    const input = z.toJSONSchema(exampleInput, { io: "input" })
    expect(input.additionalProperties).toBe(false)
    expect(input.required ?? []).toEqual([])
    expect(
      z.toJSONSchema(filterSchema, { io: "input" }).additionalProperties
    ).toBe(false)
  })

  it("keeps limits and descriptions", () => {
    const input = z.toJSONSchema(exampleInput, { io: "input" })
    expect(property(input, "top_n")).toMatchObject({
      minimum: 1,
      maximum: 50,
      default: 20,
    })
    expect(property(input, "top_n").description).toMatch(/Default: 20/)
    expect(property(input, "components")).toMatchObject({
      minItems: 1,
      maxItems: 20,
    })
    expect(property(input, "text")).toMatchObject({
      minLength: 1,
      maxLength: 200,
    })
    expect(property(input, "from")).toMatchObject({
      type: "string",
      format: "date-time",
    })
    expect(property(input, "from").description).toMatch(/inclusive/)
    expect(property(input, "to").description).toMatch(/exclusive/)
  })

  it("requires exactly one dataset and a bucket for event_trend", () => {
    const input = z.toJSONSchema(eventTrendInputSchema, { io: "input" })
    expect(input.additionalProperties).toBe(false)
    expect(input.required).toEqual(["dataset", "bucket"])
    expect(property(input, "dataset")).toMatchObject({
      type: "string",
      enum: ["bgl", "openstack"],
    })
    expect(property(input, "bucket").description).toMatch(/Monday/)
  })

  it("keeps the fact ID of check_claims a bounded string and the group required", () => {
    const input = z.toJSONSchema(checkClaimsInputSchema, { io: "input" })
    expect(property(input, "claims")).toMatchObject({
      minItems: 1,
      maxItems: 30,
    })
    const claim = asObject(property(input, "claims").items)
    expect(claim.additionalProperties).toBe(false)
    expect(claim.required).toEqual(["fact", "value", "metric", "group"])
    const fact = property(claim, "fact")
    expect(fact).toMatchObject({ type: "string", maxLength: 64 })
    // A pattern would let the SDK reject the whole call before the handler.
    expect(fact.pattern).toBeUndefined()
    expect(property(claim, "group").description).toMatch(
      /pass \{\} for ungrouped facts/
    )
  })

  it("exports describe_corpus as an empty strict object", () => {
    expect(z.toJSONSchema(emptyInputSchema, { io: "input" })).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {},
      additionalProperties: false,
    })
  })
})
