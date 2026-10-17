import { invalidInput, type ToolError } from "@workspace/domain/errors"
import {
  dimensionSchema,
  FILTER_FIELDS,
  type Dimension,
  type Filter,
  type FilterField,
} from "@workspace/domain/filters"

import type { SqlParams } from "./sql.ts"

/**
 * Filter compiler (technical.md § 8.1): turns the shared filter into SQL
 * conditions with bound parameters. Columns and expressions come only from
 * the allowlists below; values only ever become parameters.
 */

/** Searches read the full-text index relation; everything else reads the table (gate G4). */
type Relation = "log_events" | "log_events_idx"

export type CompiledFilter = {
  /** Conditions joined with AND; `TRUE` when the filter is empty. */
  where: string
  relation: Relation
}

const QUALIFIER = /^[a-z_][a-z0-9_]*$/

/** Plain column per equality field. */
const EQUALS: Partial<Record<FilterField, string>> = {
  dataset: "dataset",
  node: "node",
  rack: "rack",
  alert_label: "alert_label",
  request_id: "request_id",
  instance_id: "instance_id",
  pattern_id: "pattern_id",
}

/** Plain column per list field. */
const IN_LIST: Partial<Record<FilterField, string>> = {
  components: "component",
  levels: "level",
}

/** Grouping dimensions (§ 8.1) and the SQL they read. */
const DIMENSIONS: Record<Dimension, (q: string) => string> = {
  dataset: (q) => `${q}.dataset`,
  team: teamExpression,
  component: (q) => `${q}.component`,
  level: (q) => `${q}.level`,
  alert_label: (q) => `${q}.alert_label`,
  rack: (q) => `${q}.rack`,
  node: (q) => `${q}.node`,
  pattern: (q) => `${q}.pattern_id`,
  http_status: (q) => `${q}.http_status`,
  endpoint: (q) => `${q}.endpoint`,
}

/**
 * Team of the row's component from the fictional ownership table; components
 * without an entry are `unowned` (concept § 5.3). Outer columns are always
 * qualified, otherwise they would bind to `ownership` inside the subquery.
 */
function teamExpression(q: string): string {
  return `coalesce((SELECT o.team FROM ownership o WHERE o.dataset = ${q}.dataset AND o.component = ${q}.component), 'unowned')`
}

/**
 * SQL expression of a grouping dimension. The schema already restricts
 * dimensions, so an unknown name here is a tool bug and throws.
 */
export function dimensionExpression(
  dimension: string,
  qualifier: string
): string {
  checkQualifier(qualifier)
  const parsed = dimensionSchema.safeParse(dimension)
  if (!parsed.success) throw new RangeError(`unknown dimension: ${dimension}`)
  return DIMENSIONS[parsed.data](qualifier)
}

export type CompileOptions = {
  /** Fields the tool declared with `pickFilter`; any other present field is rejected. */
  accepted: readonly FilterField[]
  params: SqlParams
  /** Table alias used in the FROM clause; defaults to the relation name. */
  alias?: string
  /**
   * Reads the full-text index relation even without `text`, for tools that
   * add their own full-text condition (search_logs). Default: the index only
   * when `text` is present.
   */
  relation?: Relation
}

/**
 * Compiles the filter into one WHERE condition. Time bounds are bound as text
 * and compared as `TIMESTAMPTZ`, `[from, to)`; `ts` stays a column filter
 * outside the index (gate G4). `text` matches all terms (`plainto_tsquery`,
 * gate G4) and switches the relation to the index.
 */
export function compileFilter(
  filter: Partial<Filter>,
  options: CompileOptions
): { ok: true; filter: CompiledFilter } | { ok: false; error: ToolError } {
  const present = FILTER_FIELDS.filter((field) => filter[field] !== undefined)
  const unsupported = present.filter(
    (field) => !options.accepted.includes(field)
  )
  if (unsupported.length > 0) {
    return {
      ok: false,
      error: invalidInput(
        unsupported.map((path) => ({ path, message: "Unsupported field." })),
        `Remove ${unsupported.join(", ")}; this tool does not support it. Accepted fields: ${options.accepted.join(", ")}.`
      ),
    }
  }

  const relation: Relation =
    options.relation ??
    (filter.text === undefined ? "log_events" : "log_events_idx")
  if (filter.text !== undefined && relation !== "log_events_idx")
    throw new Error("a text filter needs the full-text index relation")
  const q = options.alias ?? relation
  checkQualifier(q)
  const { params } = options
  const conditions: string[] = []

  for (const field of present) {
    const column = EQUALS[field]
    const listColumn = IN_LIST[field]
    if (column !== undefined) {
      conditions.push(
        `${q}.${column} = ${params.add(stringValue(filter, field))}`
      )
    } else if (listColumn !== undefined) {
      conditions.push(
        `${q}.${listColumn} IN (${params.list(listValue(filter, field))})`
      )
    } else {
      switch (field) {
        case "from":
          conditions.push(
            `${q}.ts >= ${params.add(stringValue(filter, field))}::TIMESTAMPTZ`
          )
          break
        case "to":
          conditions.push(
            `${q}.ts < ${params.add(stringValue(filter, field))}::TIMESTAMPTZ`
          )
          break
        case "teams":
          conditions.push(
            `${teamExpression(q)} IN (${params.list(listValue(filter, field))})`
          )
          break
        case "only_errors":
          if (filter.only_errors === true) conditions.push(`${q}.is_error`)
          break
        case "only_alerts":
          if (filter.only_alerts === true) conditions.push(`${q}.is_alert`)
          break
        case "text":
          conditions.push(
            `${q}.message @@ plainto_tsquery(${params.add(stringValue(filter, field))})`
          )
          break
        default:
          throw new Error(`filter field without compiler rule: ${field}`)
      }
    }
  }

  return {
    ok: true,
    filter: {
      where: conditions.length === 0 ? "TRUE" : conditions.join(" AND "),
      relation,
    },
  }
}

function stringValue(filter: Partial<Filter>, field: FilterField): string {
  const value = filter[field]
  if (typeof value !== "string") throw new TypeError(`${field} is not a string`)
  return value
}

function listValue(filter: Partial<Filter>, field: FilterField): string[] {
  const value = filter[field]
  if (!Array.isArray(value)) throw new TypeError(`${field} is not a list`)
  return value
}

function checkQualifier(qualifier: string): void {
  if (!QUALIFIER.test(qualifier))
    throw new RangeError(`invalid table qualifier: ${qualifier}`)
}
