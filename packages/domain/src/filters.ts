import { z } from "zod"

import { invalidInput, type InputIssue, type ToolError } from "./errors.ts"
import { instantSchema, MAX_FRACTION_DIGITS, parseInstant } from "./time.ts"

/**
 * The shared filter (technical.md § 8.1). Tools pick the fields they accept
 * with `pickFilter`, so the schema the model sees and the description list the
 * same fields. Every field is optional; an absent field means "no filter".
 * Cross-field rules that JSON Schema cannot express live in `validateFilter`,
 * which the registry runs after the schema parse.
 */

export const datasetSchema = z
  .enum(["bgl", "openstack"])
  .describe(
    "Dataset: bgl (BlueGene/L, 2005–2006) or openstack (2017). They share no time axis."
  )

export type Dataset = z.infer<typeof datasetSchema>

/** Grouping dimensions (§ 8.1); tools allowlist a subset. */
export const dimensionSchema = z
  .enum([
    "dataset",
    "team",
    "component",
    "level",
    "alert_label",
    "rack",
    "node",
    "pattern",
    "http_status",
    "endpoint",
  ])
  .describe("Grouping dimension.")

export type Dimension = z.infer<typeof dimensionSchema>

const name = (max: number) => z.string().min(1).max(max)

/**
 * Level names stay an open, bounded string until profiling (U03, concept O-07)
 * fixes the observed set; unknown levels are their own category (R-02).
 */
const levelSchema = z
  .string()
  .regex(/^[A-Z][A-Z_]{0,15}$/)
  .describe("Level as stored, upper case, e.g. INFO, WARNING, ERROR, FATAL.")

const httpStatusSchema = z.number().int().min(100).max(599)

const filterShape = {
  dataset: datasetSchema.optional(),
  from: instantSchema
    .optional()
    .describe(
      "Window start, inclusive. ISO-8601 with Z or ±HH:MM and at most 6 fractional digits, e.g. 2005-06-03T00:00:00Z. Default: start of the data span."
    ),
  to: instantSchema
    .optional()
    .describe(
      "Window end, exclusive. ISO-8601 with Z or ±HH:MM, later than from. Default: end of the data span."
    ),
  components: z
    .array(name(64))
    .min(1)
    .max(20)
    .optional()
    .describe(
      "Only these components (exact names, 1–20). BGL: e.g. KERNEL; OpenStack: e.g. nova-compute."
    ),
  teams: z
    .array(name(64))
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Only components owned by these teams (fictional ownership table, 1–10); unmapped components are 'unowned'."
    ),
  levels: z
    .array(levelSchema)
    .min(1)
    .max(10)
    .optional()
    .describe("Only these levels (1–10)."),
  node: name(64)
    .optional()
    .describe("BGL only: exact node ID, e.g. R02-M1-N0-C:J12-U11."),
  rack: name(16).optional().describe("BGL only: rack, e.g. R02."),
  alert_label: name(32)
    .optional()
    .describe(
      "BGL only: dataset alert label (not our finding), e.g. KERNDTLB."
    ),
  only_errors: z
    .boolean()
    .optional()
    .describe("Only error events (R-02 levels per dataset). Default: false."),
  only_alerts: z
    .boolean()
    .optional()
    .describe(
      "BGL only: only lines with an alert label other than '-'. Default: false."
    ),
  request_id: name(64)
    .optional()
    .describe("OpenStack only: exact request ID, e.g. req-<uuid>."),
  instance_id: name(64)
    .optional()
    .describe("OpenStack only: exact instance UUID."),
  endpoints: z
    .array(name(200))
    .min(1)
    .max(20)
    .optional()
    .describe(
      "OpenStack only: only API accesses to these endpoints (1–20), exactly as returned with IDs masked, e.g. /v2/<ID>/servers/detail."
    ),
  http_status: z
    .strictObject({
      min: httpStatusSchema.describe("Lowest status, inclusive."),
      max: httpStatusSchema.describe("Highest status, inclusive."),
    })
    .optional()
    .describe(
      "OpenStack only: only API accesses whose HTTP status lies in [min, max], both inclusive, e.g. {min: 500, max: 599} for 5xx or {min: 400, max: 499} for 4xx."
    ),
  pattern_id: z
    .string()
    .regex(/^[0-9a-f]{8,64}$/)
    .optional()
    .describe(
      "Exact pattern ID as returned by recurring_patterns (lower-case hex)."
    ),
  text: name(200)
    .optional()
    .describe(
      "Full-text condition on the message, all terms must match (1–200 characters)."
    ),
}

export const filterSchema = z.strictObject(filterShape)

export type Filter = z.infer<typeof filterSchema>

export type FilterField = keyof typeof filterShape

export const FILTER_FIELDS = filterSchema.keyof().options

const BGL_ONLY: readonly FilterField[] = [
  "node",
  "rack",
  "alert_label",
  "only_alerts",
]
const OPENSTACK_ONLY: readonly FilterField[] = [
  "request_id",
  "instance_id",
  "endpoints",
  "http_status",
]

export type PickedFilter<K extends FilterField> = {
  /** Accepted fields in declaration order. */
  fields: readonly K[]
  /** Spread into a tool's strict input object. */
  shape: Pick<typeof filterShape, K>
  /** Sentence for the tool description, naming the same fields as the schema. */
  summary: string
}

/** Declares the filter fields a tool accepts. */
export function pickFilter<K extends FilterField>(
  fields: readonly K[]
): PickedFilter<K> {
  const wanted = new Set<FilterField>(fields)
  const ordered = FILTER_FIELDS.filter((field) => wanted.has(field))
  const shape: Partial<Record<FilterField, (typeof filterShape)[FilterField]>> =
    {}
  for (const field of ordered) shape[field] = filterShape[field]
  return {
    // Narrowing is safe: `ordered` and `shape` contain exactly the members of K.
    fields: ordered as K[],
    shape: shape as Pick<typeof filterShape, K>,
    summary: `Accepted filters: ${ordered.join(", ")}. Other fields are rejected with invalid_input.`,
  }
}

/**
 * Cross-field checks after the schema parse: `from < to`, microsecond
 * precision, and dataset-specific fields. Returns `null` when the filter is valid.
 */
export function validateFilter(filter: Partial<Filter>): ToolError | null {
  const issues: InputIssue[] = []
  const from = checkInstant(filter.from, "from", issues)
  const to = checkInstant(filter.to, "to", issues)
  if (from !== null && to !== null && from >= to) {
    issues.push({
      path: "to",
      message: "Must be later than from; windows are [from, to).",
    })
  }
  if (
    filter.http_status !== undefined &&
    filter.http_status.min > filter.http_status.max
  ) {
    issues.push({
      path: "http_status",
      message: "min must not exceed max; both bounds are inclusive.",
    })
  }

  const present = (fields: readonly FilterField[]) =>
    fields.filter((field) => filter[field] !== undefined)
  const bglFields = present(BGL_ONLY)
  const openstackFields = present(OPENSTACK_ONLY)
  if (filter.dataset === "openstack") {
    for (const field of bglFields)
      issues.push({ path: field, message: "Only available for dataset bgl." })
  } else if (filter.dataset === "bgl") {
    for (const field of openstackFields) {
      issues.push({
        path: field,
        message: "Only available for dataset openstack.",
      })
    }
  } else if (bglFields.length > 0 && openstackFields.length > 0) {
    issues.push({
      path: "",
      message: `${bglFields.join(", ")} (bgl) and ${openstackFields.join(", ")} (openstack) exclude each other.`,
    })
  }

  return issues.length === 0 ? null : invalidInput(issues)
}

function checkInstant(
  value: string | undefined,
  path: "from" | "to",
  issues: InputIssue[]
): bigint | null {
  if (value === undefined) return null
  const micros = parseInstant(value)
  if (micros === null) {
    issues.push({
      path,
      message: `Use ISO-8601 with Z or ±HH:MM and at most ${MAX_FRACTION_DIGITS} fractional digits.`,
    })
  }
  return micros
}
