import { invalidInput, type ToolError } from "@workspace/domain/errors"
import {
  dimensionSchema,
  FILTER_FIELDS,
  type Dimension,
  type Filter,
  type FilterField,
} from "@workspace/domain/filters"

import {
  logEventsRelation,
  type Relation,
  type RelationColumn,
} from "./relations.ts"
import type { SqlParams } from "./sql.ts"

/**
 * Filter compiler (technical.md § 8.1): turns the shared filter into SQL
 * conditions with bound parameters. Columns and expressions come only from
 * the allowlists below; values only ever become parameters.
 */

/** Searches read the full-text index relation; everything else reads the table (gate G4). */
type TableName = "log_events" | "log_events_idx"

export type CompiledFilter = {
  /** Conditions joined with AND; `TRUE` when the filter is empty. */
  where: string
  /** Table name of a log_events relation; the qualifier of other relations. */
  relation: string
  /** The relation the conditions are written against (LOG-35). */
  rel: Relation
}

const QUALIFIER = /^[a-z_][a-z0-9_]*$/

/** Plain column per equality field. */
const EQUALS: Partial<Record<FilterField, RelationColumn>> = {
  dataset: "dataset",
  node: "node",
  rack: "rack",
  alert_label: "alert_label",
  request_id: "request_id",
  instance_id: "instance_id",
  block_id: "block_id",
  host: "host",
  process_id: "process_id",
  client_ip: "client_ip",
  thread: "thread",
  trace_id: "trace_id",
  pattern_id: "pattern_id",
}

/** Plain column per list field. */
const IN_LIST: Partial<Record<FilterField, RelationColumn>> = {
  components: "component",
  levels: "level",
  endpoints: "endpoint",
}

/** Grouping dimensions (§ 8.1) and the SQL they read. */
const DIMENSIONS: Record<Dimension, (rel: Relation) => string> = {
  dataset: (rel) => rel.col("dataset"),
  team: teamExpression,
  component: (rel) => rel.col("component"),
  level: (rel) => rel.col("level"),
  alert_label: (rel) => rel.col("alert_label"),
  rack: (rel) => rel.col("rack"),
  node: (rel) => rel.col("node"),
  pattern: (rel) => rel.col("pattern_id"),
  http_status: (rel) => rel.col("http_status"),
  endpoint: (rel) => rel.col("endpoint"),
  host: (rel) => rel.col("host"),
  client_ip: (rel) => rel.col("client_ip"),
  thread: (rel) => rel.col("thread"),
  block_id: (rel) => rel.col("block_id"),
}

/**
 * Team of the row's component from the fictional ownership table; components
 * without an entry are `unowned` (concept § 5.3). Outer columns are always
 * qualified, otherwise they would bind to `ownership` inside the subquery.
 */
function teamExpression(rel: Relation): string {
  return `coalesce((SELECT o.team FROM ownership o WHERE o.dataset = ${rel.col("dataset")} AND o.component = ${rel.col("component")}), 'unowned')`
}

/** A plain qualifier (log_events columns), or a relation with its own column SQL. */
function relationOf(target: string | Relation): Relation {
  if (typeof target !== "string") return target
  checkQualifier(target)
  return logEventsRelation({ alias: target })
}

/**
 * SQL expression of a grouping dimension. The schema already restricts
 * dimensions, so an unknown name here is a tool bug and throws.
 */
export function dimensionExpression(
  dimension: string,
  target: string | Relation
): string {
  const parsed = dimensionSchema.safeParse(dimension)
  if (!parsed.success) throw new RangeError(`unknown dimension: ${dimension}`)
  return DIMENSIONS[parsed.data](relationOf(target))
}

/**
 * R-01 API accesses: OpenStack lines with an HTTP status, with or without
 * request ID. The same condition as the view `api_access`
 * (corpus/sql/40_stats.sql), written against the relation a tool reads so it
 * also applies on the full-text index relation, which the view is not.
 */
export function apiAccessCondition(qualifier: string): string {
  checkQualifier(qualifier)
  return `${qualifier}.dataset = 'openstack' AND ${qualifier}.http_status IS NOT NULL`
}

export type CompileOptions = {
  /** Fields the tool declared with `pickFilter`; any other present field is rejected. */
  accepted: readonly FilterField[]
  params: SqlParams
  /** Table alias used in the FROM clause; defaults to the relation name. */
  alias?: string
  /**
   * Reads the full-text index relation even without `text`, for tools that
   * add their own full-text condition (search_logs), or another relation
   * (LOG-35: the otel index or a direct scan). Default: the index only
   * when `text` is present.
   */
  relation?: TableName | Relation
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

  const requested: TableName | Relation =
    options.relation ??
    (filter.text === undefined ? "log_events" : "log_events_idx")
  const rel =
    typeof requested === "string"
      ? logEventsRelation({
          indexed: requested === "log_events_idx",
          ...(options.alias === undefined ? {} : { alias: options.alias }),
        })
      : requested
  if (filter.text !== undefined && !rel.indexed)
    throw new Error("a text filter needs the full-text index relation")
  if (
    rel.dataset !== null &&
    filter.dataset !== undefined &&
    filter.dataset !== rel.dataset
  )
    throw new Error(`relation of ${rel.dataset} filtered by ${filter.dataset}`)
  const relation =
    typeof requested === "string"
      ? requested
      : rel.dataset === null
        ? rel.from
        : rel.q
  const { params } = options
  const conditions: string[] = []

  for (const field of present) {
    const column = EQUALS[field]
    const listColumn = IN_LIST[field]
    if (field === "dataset" && rel.dataset !== null) {
      // A single-dataset relation holds only rows of that dataset.
      continue
    } else if (column !== undefined) {
      conditions.push(
        `${rel.col(column)} = ${params.add(stringValue(filter, field))}`
      )
    } else if (listColumn !== undefined) {
      conditions.push(
        `${rel.col(listColumn)} IN (${params.list(listValue(filter, field))})`
      )
    } else {
      switch (field) {
        case "from":
          conditions.push(
            `${rel.col("ts")} >= ${rel.bound(params.add(stringValue(filter, field)))}`
          )
          break
        case "to":
          conditions.push(
            `${rel.col("ts")} < ${rel.bound(params.add(stringValue(filter, field)))}`
          )
          break
        case "teams":
          conditions.push(
            `${teamExpression(rel)} IN (${params.list(listValue(filter, field))})`
          )
          break
        case "only_errors":
          if (filter.only_errors === true) conditions.push(rel.col("is_error"))
          break
        case "only_alerts":
          if (filter.only_alerts === true) conditions.push(rel.col("is_alert"))
          break
        case "http_status": {
          const range = filter.http_status
          if (range === undefined) throw new TypeError("http_status is unset")
          conditions.push(
            `${rel.col("http_status")} BETWEEN ${params.add(range.min)} AND ${params.add(range.max)}`
          )
          break
        }
        case "text":
          conditions.push(
            `${rel.col("message")} @@ plainto_tsquery(${params.add(stringValue(filter, field))})`
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
      rel,
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
