import {
  DATASETS,
  OTEL_COLUMNS,
  type Dataset,
  type DatasetColumn,
} from "@workspace/domain/datasets"
import type { BucketUnit } from "@workspace/domain/time"

import type { SqlParams } from "./sql.ts"

/**
 * Relation resolver (LOG-35, design D2): every tool reads its events through
 * a `Relation`, so the same filter compiler and the same SQL shapes serve
 * log_events, its full-text index and the remote OpenTelemetry relations.
 * A relation names its FROM item and the SQL of every log_events-compatible
 * column; columns a relation does not carry are typed NULLs, never zeros or
 * empty strings. Expressions come only from this module and the catalog;
 * values from input are always bound parameters.
 */

/** Columns a relation exposes under the log_events names. */
export type RelationColumn =
  DatasetColumn | "event_id" | "dataset" | "is_alert" | "pattern_id" | "pattern"

export type Relation = {
  /** Qualifier of the relation's columns. */
  readonly q: string
  /** FROM item, e.g. `log_events`, `log_events e` or `(…) AS otel_scan`. */
  readonly from: string
  /** The full-text index relation: `@@`, BM25 and ts_offsets apply to it. */
  readonly indexed: boolean
  /**
   * The one dataset of a single-dataset relation (remote datasets); null for
   * log_events, whose rows carry their dataset in a column.
   */
  readonly dataset: Dataset | null
  /** SQL of a column; a typed NULL when the relation does not carry it. */
  col(column: RelationColumn): string
  /** A bound instant (`$n`) cast to the type of the relation's ts column. */
  bound(ref: string): string
  /** Epoch microseconds of a ts expression, truncated (never rounded). */
  epochMicros(expr: string): string
  /** UTC bucket start of the relation's ts for a trend unit, truncated. */
  bucket(unit: BucketUnit): string
}

const NULLS: Partial<Record<RelationColumn, string>> = {
  event_id: "NULL::BIGINT",
  ts: "NULL::TIMESTAMPTZ",
  is_error: "NULL::BOOLEAN",
  is_alert: "NULL::BOOLEAN",
  is_anomalous: "NULL::BOOLEAN",
  http_status: "NULL::INTEGER",
  latency_ms: "NULL::DOUBLE",
  severity_number: "NULL::INTEGER",
}

const nullOf = (column: RelationColumn) => NULLS[column] ?? "NULL::VARCHAR"

const QUALIFIER = /^[a-z_][a-z0-9_]*$/

function checkQualifier(qualifier: string): void {
  if (!QUALIFIER.test(qualifier))
    throw new RangeError(`invalid table qualifier: ${qualifier}`)
}

const OTEL_ONLY = new Set<RelationColumn>(OTEL_COLUMNS)

/**
 * log_events or its index `log_events_idx` (corpus/sql/25, 50). The
 * OpenTelemetry columns exist only in the otel relations, so they are NULL
 * here. `alias` keeps the table name in FROM and qualifies by the alias.
 */
export function logEventsRelation(
  options: { indexed?: boolean; alias?: string } = {}
): Relation {
  const table = options.indexed === true ? "log_events_idx" : "log_events"
  const q = options.alias ?? table
  checkQualifier(q)
  return {
    q,
    from: options.alias === undefined ? table : `${table} ${options.alias}`,
    indexed: options.indexed === true,
    dataset: null,
    col: (column) =>
      OTEL_ONLY.has(column) ? nullOf(column) : `${q}.${column}`,
    bound: (ref) => `${ref}::TIMESTAMPTZ`,
    epochMicros: (expr) => `epoch_us(${expr})`,
    bucket: (unit) => `date_trunc('${unit}', ${q}.ts)`,
  }
}

export const LOG_EVENTS = logEventsRelation()
export const LOG_EVENTS_IDX = logEventsRelation({ indexed: true })

// ------------------------------------------------------------ remote Parquet

const NANO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/
const LEVEL_LITERAL = /^[a-z]+$/

/** A loader-written nanosecond instant, checked before it becomes a literal. */
function nanoLiteral(value: string): string {
  if (!NANO_INSTANT.test(value))
    throw new RangeError(`not a nanosecond UTC instant: ${value}`)
  return `'${value}'::TIMESTAMPTZ_NS`
}

/**
 * A Parquet location from otel_sources as a SQL literal. read_parquet and
 * read_blob need literal paths (a bound path is described as `unknown`,
 * gate G1), so the value is checked against the catalog allowlist or a
 * plain absolute fixture path, and quoted.
 */
export function parquetLiteral(location: string): string {
  const allowlisted = DATASETS.otel.remote.files.some(
    (file) => file.url === location || file.s3 === location
  )
  const fixture =
    /^\/[A-Za-z0-9_./-]+\.parquet$/.test(location) && !location.includes("..")
  if (!allowlisted && !fixture)
    throw new RangeError(`not an allowlisted Parquet location: ${location}`)
  return `'${location.replaceAll("'", "''")}'`
}

/** Exact ns timestamps as ISO text with nine fractional digits. */
export function isoNanos(expr: string): string {
  return `strftime(${expr}, '%Y-%m-%dT%H:%M:%S.%nZ')`
}

const otelSpec = DATASETS.otel
const otel = otelSpec.remote

/** SeverityText values of R-02 as literals; the catalog lists them. */
function errorLevels(): string {
  return otel.errorLevels
    .map((level) => {
      if (!LEVEL_LITERAL.test(level)) throw new RangeError(level)
      return `'${level}'`
    })
    .join(", ")
}

/** ts of a nanosecond relation truncated to microseconds (never rounded). */
const nanoBucket = (unit: BucketUnit, ts: string) =>
  `date_trunc('${unit}', make_timestamptz(epoch_ns(${ts}) // 1000))`

/** First event_id of a file of the otel dataset, as SQL text. */
function fileOffset(fileIndex: number): string {
  return String(otelSpec.eventIdBase + fileIndex * otel.eventIdFileStride)
}

/** One file's assigned half-open range [from, to); `to` null for the last file. */
export type AssignedRange = {
  file_index: number
  from: string
  to: string | null
}

/**
 * The inverted index over the reference-window view (corpus/sql/61). Its
 * view keeps the fast path (renames only), so event_id, dataset and
 * is_error are expressions here: the file of a row follows from its ts and
 * the half-open assigned ranges, the row from file_row_number (INCLUDE).
 */
export function otelIndexRelation(
  index: string,
  ranges: readonly AssignedRange[]
): Relation {
  checkQualifier(index)
  const q = index
  const [first, ...rest] = ranges
  if (first === undefined) throw new RangeError("no reference files")
  // Later files first: a row belongs to the last file whose range starts at or before it.
  const offset =
    rest.length === 0
      ? fileOffset(first.file_index)
      : `CASE ${rest
          .toReversed()
          .map(
            (range) =>
              `WHEN ${q}.ts >= ${nanoLiteral(range.from)} THEN ${fileOffset(range.file_index)}`
          )
          .join(" ")} ELSE ${fileOffset(first.file_index)} END`
  const columns: Partial<Record<RelationColumn, string>> = {
    event_id: `(${offset}::BIGINT + ${q}.file_row_number)`,
    dataset: "'otel'::VARCHAR",
    ts: `${q}.ts`,
    level: `${q}.level`,
    component: `${q}.component`,
    source_type: `${q}.source_type`,
    message: `${q}.message`,
    is_error: `(${q}.level IN (${errorLevels()}))`,
    trace_id: `${q}.trace_id`,
    span_id: `${q}.span_id`,
    severity_number: `${q}.severity_number::INTEGER`,
  }
  return {
    q,
    from: q,
    indexed: true,
    dataset: "otel",
    col: (column) => columns[column] ?? nullOf(column),
    bound: (ref) => `${ref}::TIMESTAMPTZ_NS`,
    epochMicros: (expr) => `(epoch_ns(${expr}) // 1000)`,
    bucket: (unit) => nanoBucket(unit, `${q}.ts`),
  }
}

/** One file of a direct scan with the bounds that apply to it. */
export type ScanFile = {
  file_index: number
  url: string
  /** Inclusive lower bound, nanosecond ISO. */
  read_from: string
  /** Exclusive upper bound, nanosecond ISO. */
  read_to: string
}

const SCAN = "otel_scan"

/** The columns of a direct-scan branch, renamed to the log_events names. */
const SCAN_COLUMNS = [
  "event_id",
  "dataset",
  "ts",
  "level",
  "component",
  "source_type",
  "is_error",
  "trace_id",
  "span_id",
  "severity_number",
  "message",
] as const satisfies readonly RelationColumn[]

const scanColumns = new Set<RelationColumn>(SCAN_COLUMNS)

/**
 * Bounded direct scan over the HTTPS files (design D3.2): one read_parquet
 * per file with its own half-open bounds, combined with UNION ALL, so a
 * boundary row present in two files is read once. The bounds stay plain
 * `"Timestamp" op $n::TIMESTAMPTZ_NS` comparisons: they are pushed into the
 * reader and prune row groups; any expression on the column would disable
 * pruning (LOG-35 probe § 2.4). Binds the bounds into `params`, so a
 * relation belongs to the one statement that owns `params`.
 */
export function otelScanRelation(
  files: readonly ScanFile[],
  params: SqlParams
): Relation {
  if (files.length === 0) throw new RangeError("a scan needs a file")
  const src = otel.sourceColumns
  const branches = files.map((file) => {
    const offset =
      otelSpec.eventIdBase + file.file_index * otel.eventIdFileStride
    const select = [
      `${offset}::BIGINT + file_row_number AS event_id`,
      "'otel'::VARCHAR AS dataset",
      `"${src.ts}" AS ts`,
      `"${src.level}" AS level`,
      `"${src.component}" AS component`,
      `"${src.source_type}" AS source_type`,
      `"${src.level}" IN (${errorLevels()}) AS is_error`,
      `"${src.trace_id}" AS trace_id`,
      `"${src.span_id}" AS span_id`,
      `"${src.severity_number}"::INTEGER AS severity_number`,
      `"${src.message}" AS message`,
    ].join(", ")
    return `SELECT ${select} FROM read_parquet(${parquetLiteral(file.url)}, file_row_number = true) WHERE "${src.ts}" >= ${params.add(file.read_from)}::TIMESTAMPTZ_NS AND "${src.ts}" < ${params.add(file.read_to)}::TIMESTAMPTZ_NS`
  })
  return {
    q: SCAN,
    from: `(${branches.join(" UNION ALL ")}) AS ${SCAN}`,
    indexed: false,
    dataset: "otel",
    col: (column) =>
      scanColumns.has(column) ? `${SCAN}.${column}` : nullOf(column),
    bound: (ref) => `${ref}::TIMESTAMPTZ_NS`,
    epochMicros: (expr) => `(epoch_ns(${expr}) // 1000)`,
    bucket: (unit) => nanoBucket(unit, `${SCAN}.ts`),
  }
}

/**
 * The dataset-specific attribute columns of an event row: the five
 * extension columns (U26) and the three OpenTelemetry columns (LOG-35), as
 * the relation provides them (typed NULL where it has none). The tool keeps
 * only those the row's dataset carries (extensionAttributes).
 */
export function extensionSelect(rel: Relation): string {
  return (
    [
      "host",
      "process_id",
      "client_ip",
      "thread",
      "block_id",
      "trace_id",
      "span_id",
      "severity_number",
    ] as const
  )
    .map((column) => `${rel.col(column)} AS ${column}`)
    .join(", ")
}
