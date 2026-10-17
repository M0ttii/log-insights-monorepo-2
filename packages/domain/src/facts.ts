import { z } from "zod"

import { factId, factIdSchema } from "./ids.ts"
import { parseInstant } from "./time.ts"

/**
 * Facts (technical.md § 8.3): every number and time under `/result` and
 * `/scope` that a tool declares with a `FactSpec` gets an ID the model cites
 * instead of a path. `check_claims` resolves the ID and compares value,
 * metric and group.
 */

const SNAKE = /^[a-z][a-z0-9_]*$/

export const factSpecSchema = z.strictObject({
  path: z
    .string()
    .regex(/^\/(result|scope)(\/([A-Za-z0-9_]+|\*))+$/)
    .describe(
      "Pointer from the receipt root; * matches every array element, e.g. /result/groups/*/events."
    ),
  metric: z
    .string()
    .regex(SNAKE)
    .describe("What the number measures, e.g. events, share, p95_latency."),
  unit: z
    .string()
    .regex(SNAKE)
    .describe(
      "Unit, counting units after R-01: log_events, api_accesses, requests."
    ),
  groupKeys: z
    .array(z.string().regex(SNAKE))
    .describe(
      "Dimension fields of the surrounding row that identify the group, e.g. [dataset, team]."
    ),
})

export type FactSpec = z.infer<typeof factSpecSchema>

export const factValueSchema = z.union([z.number(), z.string()])

export const factSchema = z.strictObject({
  id: factIdSchema,
  path: z
    .string()
    .describe(
      "JSON pointer of the value inside the receipt, e.g. /result/groups/2/events."
    ),
  value: factValueSchema.describe("Number, or ISO-8601 instant for times."),
  metric: z.string(),
  unit: z.string(),
  group: z
    .record(z.string(), z.string())
    .describe(
      "Dimension values of the row the value belongs to; {} for ungrouped facts."
    ),
})

export type Fact = z.infer<typeof factSchema>

export type FactSource = { result: unknown; scope: unknown }

type Segment = string | number
type Row = Record<string, unknown>

/**
 * Builds the fact list for one receipt.
 *
 * Output order, and therefore numbering from `.f1`: first `/result`, then
 * `/scope`; inside each a depth-first walk with object keys in code-point
 * order (the order of canonical JSON) and array elements by index. The order
 * does not depend on how a tool assembled its objects.
 *
 * The group of a fact holds each `groupKeys` field from the nearest enclosing
 * object that has it; a `null` dimension value is left out. A `null` value
 * produces no fact: a missing value is not zero.
 *
 * A spec that matches a container, a boolean, a non-time string, or a value
 * matched by another spec, or whose group key is nowhere in the row's
 * ancestors, is a tool bug and throws.
 */
export function buildFacts(
  receiptId: string,
  source: FactSource,
  specs: readonly FactSpec[]
): Fact[] {
  const compiled = specs.map((spec) => ({
    spec,
    segments: spec.path.split("/").slice(1),
  }))
  const facts: Fact[] = []

  const visit = (value: unknown, path: Segment[], rows: Row[]): void => {
    const spec = matchSpec(compiled, path)
    if (Array.isArray(value)) {
      if (spec) throw new Error(`fact spec ${spec.path} matches an array`)
      value.forEach((item, index) => visit(item, [...path, index], rows))
      return
    }
    if (isRow(value)) {
      if (spec) throw new Error(`fact spec ${spec.path} matches an object`)
      const keys = Object.keys(value).toSorted(compareCodePoints)
      for (const key of keys)
        visit(value[key], [...path, key], [value, ...rows])
      return
    }
    if (!spec || value === null || value === undefined) return
    const pointer = toPointer(path)
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        throw new Error(`fact ${pointer} is not a finite number`)
    } else if (typeof value !== "string" || parseInstant(value) === null) {
      throw new Error(`fact ${pointer} must be a number or an ISO-8601 instant`)
    }
    facts.push({
      id: factId(receiptId, facts.length + 1),
      path: pointer,
      value,
      metric: spec.metric,
      unit: spec.unit,
      group: groupOf(spec, rows, pointer),
    })
  }

  visit(source.result, ["result"], [])
  visit(source.scope, ["scope"], [])
  return facts
}

function matchSpec(
  compiled: readonly { spec: FactSpec; segments: string[] }[],
  path: readonly Segment[]
): FactSpec | undefined {
  const matches = compiled.filter(
    ({ segments }) =>
      segments.length === path.length &&
      segments.every((segment, i) => {
        const actual = path[i]
        return segment === "*" ? typeof actual === "number" : segment === actual
      })
  )
  if (matches.length > 1) {
    throw new Error(
      `fact specs ${matches.map((m) => m.spec.path).join(", ")} overlap`
    )
  }
  return matches[0]?.spec
}

function groupOf(
  spec: FactSpec,
  rows: readonly Row[],
  pointer: string
): Record<string, string> {
  const group: Record<string, string> = {}
  for (const key of spec.groupKeys) {
    const row = rows.find((candidate) => Object.hasOwn(candidate, key))
    if (!row)
      throw new Error(`group key ${key} of fact ${pointer} is not in its row`)
    const value = row[key]
    if (value === null) continue
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      group[key] = String(value)
    } else {
      throw new Error(`group key ${key} of fact ${pointer} is not a scalar`)
    }
  }
  return group
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** RFC 6901 pointer. */
function toPointer(path: readonly Segment[]): string {
  return path
    .map(
      (segment) =>
        `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`
    )
    .join("")
}

/**
 * Number format shared by playbooks (U15) and web (U17), technical.md § 10:
 * value with unit and fact ID. Integers get thousands separators; decimals
 * keep their digits.
 */
export const CITATION_EXAMPLE = "1,204 log events [r_7f3a9c21.f4]"

export function formatFactValue(value: number | string): string {
  if (typeof value === "string") return value
  const [integer = "", fraction] = String(Math.abs(value)).split(".")
  if (integer.includes("e")) return String(value)
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${value < 0 ? "-" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`
}

export function formatCitation(
  fact: Pick<Fact, "id" | "value" | "unit">
): string {
  return `${formatFactValue(fact.value)} ${fact.unit.replaceAll("_", " ")} [${fact.id}]`
}
