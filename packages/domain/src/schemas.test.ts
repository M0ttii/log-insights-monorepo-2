import { describe, expect, it } from "vitest"
import { z } from "zod"

import { toolErrorSchema } from "./errors.ts"
import { factSchema, factSpecSchema } from "./facts.ts"
import { filterSchema, pickFilter } from "./filters.ts"
import { receiptSchema } from "./receipt.ts"
import { changeLabelSchema } from "./rules/compare.ts"
import { dominanceSchema } from "./rules/dominance.ts"
import { rankCriterionSchema } from "./rules/ranking.ts"
import { patternStatusSchema } from "./rules/status.ts"
import { emptyInputSchema, toolResultSchema } from "./tool.ts"
import {
  countEventsInputSchema,
  countEventsOutputSchema,
} from "./tools/count-events.ts"
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
  searchLogsInput: searchLogsInputSchema,
  searchLogsOutput: searchLogsOutputSchema,
  countEventsInput: countEventsInputSchema,
  countEventsOutput: countEventsOutputSchema,
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

  it("exports describe_corpus as an empty strict object", () => {
    expect(z.toJSONSchema(emptyInputSchema, { io: "input" })).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {},
      additionalProperties: false,
    })
  })
})
