import { readFile } from "node:fs/promises"

import {
  DATASETS,
  isExtension,
  type Dataset,
  type DatasetColumn,
  type TableDataset,
} from "@workspace/domain/datasets"

import { CONTAINER_RAW_DIR } from "./config.ts"
import type { ExternalPin } from "./remote.ts"
import {
  datasetLoad,
  joinPosix,
  type ExternalLoad,
  type Source,
} from "./sources.ts"
import { sqlString, sqlStringList } from "./sql-script.ts"
import { VERSIONS } from "./versions.ts"

/** Durations measured so far in a run, per dataset (read + parse) and shared. */
export type Timings = Partial<Record<Dataset, number>> & { shared: number }

/**
 * Facts a run learns while it loads, for the steps after: the remote pins
 * (Node, before any SQL), the assigned ranges after 60_otel_sources.sql and
 * the index build after 61_otel_reference.sql (LOG-35).
 */
export type LoadFacts = {
  otelPins?: readonly ExternalPin[]
  /** Half-open assigned ranges as nanosecond ISO strings; `to` null for the last file. */
  otelRanges?: readonly {
    file_index: number
    from: string
    to: string | null
  }[]
  otelIndex?: { builtAt: string; ms: number }
}

export type Step = {
  file: SqlFile
  /** Which load time the step counts towards (report per dataset, A-02/8). */
  timing: Dataset | "shared"
  /** Bound parameters; such a file holds exactly one statement. */
  parameterised?: true
  placeholders: (timings: Timings, facts?: LoadFacts) => Record<string, string>
}

const SQL_DIR = new URL("../sql/", import.meta.url)

/** Every file in sql/, in name order; a test checks none is missing. */
export const SQL_FILES = [
  "01_schema.sql",
  "05_read.sql",
  "10_bgl.sql",
  "11_openstack.sql",
  "12_hdfs.sql",
  "13_openssh.sql",
  "14_apache.sql",
  "14_linux.sql",
  "14_zookeeper.sql",
  "15_load_report.sql",
  "20_patterns.sql",
  "25_log_events.sql",
  "30_ownership.sql",
  "40_stats.sql",
  "50_index.sql",
  "60_otel_sources.sql",
  "61_otel_reference.sql",
  "62_otel_stats.sql",
  "90_checks.sql",
  "95_manifest.sql",
  "99_cleanup.sql",
] as const

export type SqlFile = (typeof SQL_FILES)[number]

/**
 * Parser of each dataset (technical.md § 7.1). A parser writes
 * `stage_<dataset>` from `stage_lines_<dataset>`; extensions follow the
 * staging contract that the shared steps below read.
 */
const PARSER: Record<TableDataset, SqlFile> = {
  bgl: "10_bgl.sql",
  openstack: "11_openstack.sql",
  hdfs: "12_hdfs.sql",
  openssh: "13_openssh.sql",
  apache: "14_apache.sql",
  linux: "14_linux.sql",
  zookeeper: "14_zookeeper.sql",
}

const container = (path: string) => joinPosix(CONTAINER_RAW_DIR, path)

/** Empty set with the same shape as a read of the OpenStack labels file. */
const NO_LABELS = "(SELECT NULL::VARCHAR AS line WHERE false)"
/** Empty set with the same shape as a read of the HDFS labels file. */
const NO_BLOCK_LABELS =
  '(SELECT NULL::VARCHAR AS "BlockId", NULL::VARCHAR AS "Label" WHERE false)'

const none = () => ({})

const readLines = (path: string) =>
  `read_csv(${sqlString(container(path))}, columns = {'line': 'VARCHAR'}, ` +
  `delim = E'\\x1f', quote = '', escape = '', header = false, auto_detect = false)`

const readBlockLabels = (path: string) =>
  `read_csv(${sqlString(container(path))}, columns = {'BlockId': 'VARCHAR', 'Label': 'VARCHAR'}, ` +
  "header = true, auto_detect = false)"

/** Columns of the field guide: every catalog field except free text and time. */
function guideColumns(dataset: Dataset): DatasetColumn[] {
  return Object.keys(DATASETS[dataset].fields).filter(
    (column): column is DatasetColumn => column !== "ts" && column !== "message"
  )
}

/** Datasets of a source that have their labels in the source. */
function labelsAvailable(source: Source, dataset: Dataset): boolean {
  // BGL labels are the first column of every line.
  return dataset === "bgl" || datasetLoad(source, dataset).labels !== null
}

/** A dataset ID as a SQL string literal. */
const literal = (dataset: Dataset) => sqlString(dataset)
/** Joins SQL fragments onto indented continuation lines. */
const join = (parts: string[]) => parts.join("\n  ")

/**
 * SQL pieces of the shared steps that depend on the loaded datasets. Values
 * come from the catalog, never from input; identifiers from the closed list
 * of dataset IDs.
 */
function sharedPieces(source: Source) {
  const datasets = source.datasets.map((entry) => entry.dataset)
  const extensions = datasets.filter(isExtension)

  const rejects = extensions.flatMap((d) => [
    `UNION ALL SELECT ${literal(d)}, regexp_extract(filename, '[^/]+$'), line_no, reason, raw_line FROM stage_read_rejects_${d}`,
    `UNION ALL SELECT ${literal(d)}, source_file, line_no, reject_reason, line FROM stage_${d} WHERE reject_reason IS NOT NULL`,
  ])
  const files = extensions.map(
    (d) =>
      `UNION ALL SELECT ${literal(d)}, source_file, file_ord, lines FROM stage_files_${d}`
  )
  const loaded = extensions.map(
    (d) =>
      `UNION ALL SELECT ${literal(d)}, source_file, count(*) FROM stage_${d} WHERE reject_reason IS NULL GROUP BY source_file`
  )
  const events = extensions.map(
    (d) =>
      `UNION ALL SELECT ${DATASETS[d].eventIdBase} + seq, ${literal(d)}, source_file, line_no, ts, level, component, source_type, ` +
      "NULL, NULL, NULL, NULL, NULL, is_error, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, " +
      `is_anomalous, host, process_id, client_ip, thread, block_id, message FROM stage_${d} WHERE reject_reason IS NULL`
  )
  const ownership = extensions.includes("zookeeper")
    ? "UNION ALL SELECT DISTINCT 'zookeeper', component, 'Coordination Services', 'fictional (Serene Platform)', 'ZooKeeper server class: quorum, leader election, sessions and client connections' FROM stage_zookeeper WHERE reject_reason IS NULL AND component IS NOT NULL"
    : ""
  const timeBasis = `CASE b.dataset ${datasets.map((d) => `WHEN ${literal(d)} THEN ${sqlString(DATASETS[d].timeBasis)}`).join(" ")} END`
  const labelSource = `CASE ${datasets
    .flatMap((d) => {
      const labels = DATASETS[d].labels
      return labels !== null && labelsAvailable(source, d)
        ? [`WHEN b.dataset = ${literal(d)} THEN ${sqlString(labels.source)}`]
        : []
    })
    .join(" ")} ELSE 'none: this source has no anomaly labels' END`
  const fieldStats = datasets
    .flatMap((d) =>
      guideColumns(d).map(
        (c) =>
          `SELECT ${literal(d)} AS dataset, ${sqlString(c)} AS field, count(${c}) AS events_with_value, count(DISTINCT ${c}) AS distinct_values, ` +
          `coalesce((SELECT to_json(list({'value': v, 'events': n} ORDER BY n DESC, v)) FROM (SELECT ${c}::VARCHAR AS v, count(*) AS n FROM log_events ` +
          `WHERE dataset = ${literal(d)} AND ${c} IS NOT NULL GROUP BY 1 ORDER BY n DESC, v LIMIT 3)), '[]'::JSON) AS examples ` +
          `FROM log_events WHERE dataset = ${literal(d)}`
      )
    )
    .join("\nUNION ALL\n")
  const visibility = extensions.map((d) => {
    const term = DATASETS[d].probeTerm
    if (!/^[a-z]+$/.test(term)) throw new Error(`probe term of ${d}: ${term}`)
    const regex = `regexp_matches(lower(message), '(^|[^a-z0-9_])${term}([^a-z0-9_]|$)')`
    const mid = `(SELECT mid FROM spans WHERE dataset = ${literal(d)})`
    return (
      `UNION ALL SELECT ${literal(d)}, '${term}', ` +
      `(SELECT count(*) FROM log_events_idx WHERE message @@ '${term}' AND dataset = ${literal(d)}), ` +
      `(SELECT count(*) FROM log_events WHERE dataset = ${literal(d)} AND ${regex}), ` +
      `(SELECT count(*) FROM log_events_idx WHERE message @@ '${term}' AND dataset = ${literal(d)} AND ts < ${mid}), ` +
      `(SELECT count(*) FROM log_events WHERE dataset = ${literal(d)} AND ts < ${mid} AND ${regex})`
    )
  })
  const checks = extensions.flatMap((d) => extensionChecks(source, d))
  const cleanup = extensions.flatMap((d) => [
    `DROP TABLE IF EXISTS stage_read_${d};`,
    `DROP TABLE IF EXISTS stage_read_rejects_${d};`,
    `DROP TABLE IF EXISTS stage_lines_${d};`,
    `DROP TABLE IF EXISTS stage_files_${d};`,
    `DROP TABLE IF EXISTS stage_${d};`,
    ...(d === "hdfs" ? ["DROP TABLE IF EXISTS stage_hdfs_labels;"] : []),
  ])

  return {
    EXTENSION_REJECTS: join(rejects),
    EXTENSION_FILES: join(files),
    EXTENSION_LOADED: join(loaded),
    EXTENSION_EVENTS: join(events),
    DATASETS: datasets.map(literal).join(", "),
    EXTENSION_OWNERSHIP: ownership,
    TIME_BASIS: timeBasis,
    LABEL_SOURCE: labelSource,
    FIELD_STATS: fieldStats,
    EXTENSION_VISIBILITY: join(visibility),
    EXTENSION_CHECKS: join(checks),
    EXTENSION_CLEANUP: cleanup.join("\n"),
  }
}

/** The ftpd date of a Linux message and the inferred header time agree. */
const FTPD_MATCH =
  "coalesce(abs(epoch(try_strptime(message_date || ' +0000', '%b %d %H:%M:%S %Y %z')) - epoch(ts)) <= 60, false)"

/** Load checks of one extension dataset (90_checks.sql), ord 20 and up. */
function extensionChecks(source: Source, dataset: Dataset): string[] {
  switch (dataset) {
    case "hdfs": {
      const labelled = labelsAvailable(source, "hdfs")
      return [
        "UNION ALL SELECT 20, 'hdfs: every event names a block; block_id is set exactly when it names one', '0 without, 0 inconsistent', " +
          "count(*) FILTER (WHERE block_count = 0)::VARCHAR || ' without, ' || count(*) FILTER (WHERE (block_count = 1) <> (block_id IS NOT NULL)) || ' inconsistent, ' || count(*) FILTER (WHERE block_count > 1) || ' with several', " +
          "count(*) FILTER (WHERE block_count = 0) = 0 AND count(*) FILTER (WHERE (block_count = 1) <> (block_id IS NOT NULL)) = 0 " +
          "FROM stage_hdfs WHERE reject_reason IS NULL",
        "UNION ALL SELECT 21, 'hdfs: block labels are Normal or Anomaly and cover every event (when the source has labels)', " +
          `'${labelled ? "0 other labels, 0 unlabelled events" : "no labels in this source"}', ` +
          "(SELECT count(*) FROM stage_hdfs_labels WHERE label NOT IN ('Normal', 'Anomaly'))::VARCHAR || ' other labels, ' || count(*) FILTER (WHERE is_anomalous IS NULL) || ' unlabelled events', " +
          `(SELECT count(*) FROM stage_hdfs_labels WHERE label NOT IN ('Normal', 'Anomaly')) = 0 AND (${labelled ? "count(*) FILTER (WHERE is_anomalous IS NULL AND block_id IS NOT NULL) = 0" : "count(*) FILTER (WHERE is_anomalous IS NOT NULL) = 0"}) ` +
          "FROM log_events WHERE dataset = 'hdfs'",
      ]
    }
    case "openssh":
      return [
        "UNION ALL SELECT 22, 'openssh: at most one month wrap (December 2017, then January 2018)', '0 or 1', " +
          "coalesce(max(year_wraps), 0)::VARCHAR, coalesce(max(year_wraps), 0) <= 1 FROM stage_openssh",
      ]
    case "apache":
      return [
        "UNION ALL SELECT 23, 'apache: weekday in the text matches the parsed date', '0 rows', " +
          "count(*)::VARCHAR || ' rows', count(*) = 0 FROM stage_apache " +
          "WHERE reject_reason IS NULL AND strftime(ts, '%a') <> weekday_text",
      ]
    case "linux":
      return [
        "UNION ALL SELECT 24, 'linux: at most one month wrap (2005, then 2006)', '0 or 1', " +
          "coalesce(max(year_wraps), 0)::VARCHAR, coalesce(max(year_wraps), 0) <= 1 FROM stage_linux",
        // ftpd writes its own clock into the message, up to a second off
        // the syslog header; what the check proves is the inferred year.
        "UNION ALL SELECT 25, 'linux: full dates in ftpd messages match the inferred header time within 60 s (year inference)', '0 differ', " +
          `count(*) FILTER (WHERE NOT ${FTPD_MATCH})::VARCHAR || ' differ of ' || count(*), ` +
          `count(*) FILTER (WHERE NOT ${FTPD_MATCH}) = 0 ` +
          "FROM stage_linux WHERE reject_reason IS NULL AND message_date IS NOT NULL",
      ]
    default:
      return []
  }
}

/** Placeholders of a dataset's parser. */
function parserPlaceholders(
  source: Source,
  dataset: Dataset
): Record<string, string> {
  const labels = datasetLoad(source, dataset).labels
  switch (dataset) {
    case "openstack":
      return {
        OPENSTACK_LABELS: labels === null ? NO_LABELS : readLines(labels),
        OPENSTACK_LABELS_AVAILABLE: labels === null ? "false" : "true",
      }
    case "hdfs":
      return {
        HDFS_LABELS:
          labels === null ? NO_BLOCK_LABELS : readBlockLabels(labels),
        HDFS_LABELS_AVAILABLE: labels === null ? "false" : "true",
      }
    default:
      return {}
  }
}

const seconds = (ms: number | undefined) => ((ms ?? 0) / 1000).toFixed(3)

/**
 * The load steps of a source up to and including the checks. The manifest
 * (95) and cleanup (99) run separately after the checks have passed.
 */
export function loadSteps(source: Source): Step[] {
  const pieces = sharedPieces(source)
  const reads: Step[] = source.datasets.flatMap(({ dataset, logs }) => [
    {
      file: "05_read.sql",
      timing: dataset,
      placeholders: () => ({
        DATASET: dataset,
        FILES: sqlStringList(logs.map(container)),
      }),
    },
    {
      file: PARSER[dataset],
      timing: dataset,
      placeholders: () => parserPlaceholders(source, dataset),
    },
  ])
  const extensions = source.datasets
    .map((entry) => entry.dataset)
    .filter(isExtension)
  return [
    { file: "01_schema.sql", timing: "shared", placeholders: none },
    ...reads,
    {
      file: "15_load_report.sql",
      timing: "shared",
      placeholders: (timings) => ({
        BGL_LOAD_S: seconds(timings.bgl),
        OPENSTACK_LOAD_S: seconds(timings.openstack),
        EXTENSION_REJECTS: pieces.EXTENSION_REJECTS,
        EXTENSION_FILES: pieces.EXTENSION_FILES,
        EXTENSION_LOADED: pieces.EXTENSION_LOADED,
        EXTENSION_DURATIONS: extensions
          .map((d) => ` WHEN ${sqlString(d)} THEN ${seconds(timings[d])}`)
          .join(""),
      }),
    },
    { file: "20_patterns.sql", timing: "shared", placeholders: none },
    {
      file: "25_log_events.sql",
      timing: "shared",
      placeholders: () => ({ EXTENSION_EVENTS: pieces.EXTENSION_EVENTS }),
    },
    {
      file: "30_ownership.sql",
      timing: "shared",
      placeholders: () => ({
        DATASETS: pieces.DATASETS,
        EXTENSION_OWNERSHIP: pieces.EXTENSION_OWNERSHIP,
      }),
    },
    {
      file: "40_stats.sql",
      timing: "shared",
      placeholders: () => ({
        TIME_BASIS: pieces.TIME_BASIS,
        LABEL_SOURCE: pieces.LABEL_SOURCE,
        FIELD_STATS: pieces.FIELD_STATS,
      }),
    },
    { file: "50_index.sql", timing: "shared", placeholders: none },
    ...source.external.flatMap((load) => otelSteps(load)),
    {
      file: "90_checks.sql",
      timing: "shared",
      placeholders: (_timings, facts = {}) => ({
        EXTENSION_VISIBILITY: pieces.EXTENSION_VISIBILITY,
        EXTENSION_CHECKS: pieces.EXTENSION_CHECKS,
        OTEL_CHECKS: source.external
          .flatMap((load) => otelChecks(load, ranges(facts)))
          .join("\n  "),
      }),
    },
  ]
}

// ------------------------------------------------------------ otel (LOG-35)

const NANO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/
const MICRO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/

/** A catalog µs instant as a nine-digit ISO string (comparable as text). */
function nanoOf(value: string): string {
  if (NANO.test(value)) return value
  const match = MICRO.exec(value)
  if (match === null) throw new Error(`not a UTC instant: ${value}`)
  return `${match[1]}.${match[2]}000Z`
}

const nanoLiteral = (value: string) =>
  `${sqlString(nanoOf(value))}::TIMESTAMPTZ_NS`

function ranges(facts: LoadFacts): NonNullable<LoadFacts["otelRanges"]> {
  const found = facts.otelRanges
  if (found === undefined)
    throw new Error("otel assigned ranges are read after 60_otel_sources.sql")
  for (const range of found)
    if (!NANO.test(range.from) || (range.to !== null && !NANO.test(range.to)))
      throw new Error(`assigned range of file ${range.file_index} is not in ns`)
  return found
}

/** The reference files with their assigned ranges, in glob order. */
function referenceFiles(
  load: ExternalLoad,
  found: NonNullable<LoadFacts["otelRanges"]>
) {
  return load.reference.files.map((index) => {
    const file = load.files.find((entry) => entry.file_index === index)
    const range = found.find((entry) => entry.file_index === index)
    if (file === undefined || range === undefined)
      throw new Error(`reference file ${index} is not loaded`)
    return { ...file, from: range.from, to: range.to }
  })
}

/** Per reference file the bounds it answers for inside the window, as ns text. */
function boundsInWindow(
  load: ExternalLoad,
  file: { from: string; to: string | null }
): { lower: string; upper: string } {
  const from = nanoOf(load.reference.from)
  const to = nanoOf(load.reference.to)
  return {
    lower: file.from > from ? file.from : from,
    upper: file.to !== null && file.to < to ? file.to : to,
  }
}

/** The fields of the otel field guide and their expression over otel_ref. */
function otelFieldExpression(column: DatasetColumn): string {
  if (column === "is_error") return `(level IN (${errorLevels()}))`
  if (!/^[a-z_]+$/.test(column)) throw new Error(column)
  return column
}

function errorLevels(): string {
  return DATASETS.otel.remote.errorLevels
    .map((level) => sqlString(level))
    .join(", ")
}

/** The three otel steps between the index of log_events and the checks. */
function otelSteps(load: ExternalLoad): Step[] {
  const locations = sqlStringList(load.files.map((file) => file.location))
  const glob = load.reference.glob
  if (glob.includes("'")) throw new Error("glob must not contain quotes")
  return [
    {
      file: "60_otel_sources.sql",
      timing: "shared",
      placeholders: (_timings, facts = {}) => {
        const pins = facts.otelPins
        if (pins === undefined || pins.length !== load.files.length)
          throw new Error("otel pins are taken before the load steps")
        return {
          LOCATIONS: locations,
          PINS: pins
            .map(
              (pin) =>
                `(${pin.file_index}, ${sqlString(pin.location)}, ${pin.bytes}::BIGINT, ${pin.etag === null ? "NULL::VARCHAR" : sqlString(pin.etag)}, ${pin.last_modified === null ? "NULL::VARCHAR" : sqlString(pin.last_modified)})`
            )
            .join(", "),
        }
      },
    },
    {
      file: "61_otel_reference.sql",
      timing: "shared",
      placeholders: (_timings, facts = {}) => ({
        GLOB: glob,
        FROM: nanoOf(load.reference.from),
        TO: nanoOf(load.reference.to),
        DEDUPE: referenceFiles(load, ranges(facts))
          .map(
            (file) =>
              `(filename = ${sqlString(file.globName)} AND "Timestamp" >= ${nanoLiteral(file.from)}${file.to === null ? "" : ` AND "Timestamp" < ${nanoLiteral(file.to)}`})`
          )
          .join(" OR "),
      }),
    },
    {
      file: "62_otel_stats.sql",
      timing: "shared",
      placeholders: (_timings, facts = {}) => {
        const index = facts.otelIndex
        if (index === undefined)
          throw new Error(
            "the otel index build is timed in 61_otel_reference.sql"
          )
        const columns = guideColumns(load.dataset)
        return {
          GLOB: glob,
          FROM: nanoOf(load.reference.from),
          TO: nanoOf(load.reference.to),
          BUILT_AT: index.builtAt,
          BUILD_MS: index.ms.toFixed(1),
          MAPPING_VERSION: VERSIONS.otelMapping,
          ERROR_LEVELS: errorLevels(),
          TIME_BASIS: sqlString(DATASETS[load.dataset].timeBasis),
          LABEL_SOURCE: sqlString("none: this dataset has no labels"),
          FIELD_STATS: columns
            .map((column) => {
              const value = otelFieldExpression(column)
              return (
                `SELECT ${literal(load.dataset)} AS dataset, ${sqlString(column)} AS field, count(${value}) AS events_with_value, count(DISTINCT ${value}) AS distinct_values, ` +
                `coalesce((SELECT to_json(list({'value': v, 'events': n} ORDER BY n DESC, v)) FROM (SELECT ${value}::VARCHAR AS v, count(*) AS n FROM otel_ref ` +
                `WHERE ${value} IS NOT NULL GROUP BY 1 ORDER BY n DESC, v LIMIT 3)), '[]'::JSON) AS examples FROM otel_ref`
              )
            })
            .join("\nUNION ALL\n"),
        }
      },
    },
  ]
}

/** Twin hash of a text_bench row: every column a duplicate must repeat. */
const ROW_HASH =
  'md5(concat_ws(chr(31), "Timestamp"::VARCHAR, "TraceId", "SpanId", "TraceFlags"::VARCHAR, "SeverityText", "SeverityNumber"::VARCHAR, "ServiceName", "Body", "ScopeName", "ScopeVersion", "ResourceAttributes"::VARCHAR, "ScopeAttributes"::VARCHAR, "LogAttributes"::VARCHAR))'

/** Load checks of a remote dataset (90_checks.sql), ord 30 and up. */
function otelChecks(
  load: ExternalLoad,
  found: NonNullable<LoadFacts["otelRanges"]>
): string[] {
  const files = load.files.length
  const consistent =
    "coalesce(footer_rows = row_group_rows AND row_groups = row_group_count AND size = footer_file_bytes AND size = head_size " +
    "AND (head_last_modified IS NULL OR head_last_modified = last_modified), false)"
  const reference = referenceFiles(load, found)
  // The analytics shape of a direct scan: one HTTPS (or fixture) read per
  // file with its own half-open bounds inside the window.
  const direct = reference
    .map((file) => {
      const { lower, upper } = boundsInWindow(load, file)
      return `(SELECT count(*) FROM read_parquet(${sqlString(file.location)}) WHERE "Timestamp" >= ${nanoLiteral(lower)} AND "Timestamp" < ${nanoLiteral(upper)})`
    })
    .join(" + ")
  // Rows of a file at or after the next file's start are dropped by the
  // half-open rule; each must have an identical twin in the next file.
  const twins = reference
    .slice(0, -1)
    .map((file, i) => {
      const next = reference[i + 1]
      if (next === undefined || file.to === null) return "0"
      const to = nanoLiteral(load.reference.to)
      return (
        `(SELECT count(*) FROM (SELECT ${ROW_HASH} AS h FROM read_parquet(${sqlString(file.location)}) WHERE "Timestamp" >= ${nanoLiteral(file.to)} AND "Timestamp" < ${to}) d ` +
        `WHERE d.h IN (SELECT ${ROW_HASH} FROM read_parquet(${sqlString(next.location)}) WHERE "Timestamp" >= ${nanoLiteral(file.to)} AND "Timestamp" < ${to}))`
      )
    })
    .join(" + ")
  const term = DATASETS[load.dataset].probeTerm
  if (!/^[a-z]+$/.test(term))
    throw new Error(`probe term of ${load.dataset}: ${term}`)
  const regex = `regexp_matches(lower(message), '(^|[^a-z0-9_])${term}([^a-z0-9_]|$)')`
  return [
    `UNION ALL SELECT 30, 'otel: per file footer rows = row-group rows, read_blob size = footer size = HEAD Content-Length, HEAD Last-Modified = read_blob', '${files} of ${files} files', ` +
      `count(*) FILTER (WHERE ${consistent})::VARCHAR || ' of ' || count(*) || ' files', count(*) FILTER (WHERE NOT ${consistent}) = 0 AND count(*) = ${files} FROM otel_sources`,
    "UNION ALL SELECT 31, 'otel: files ascend in time; each assigned range [ts_min(n), ts_min(n+1)) is non-empty', '0 out of order', " +
      "count(*) FILTER (WHERE assigned_to IS NOT NULL AND assigned_to <= assigned_from)::VARCHAR || ' out of order', " +
      "count(*) FILTER (WHERE assigned_to IS NOT NULL AND assigned_to <= assigned_from) = 0 FROM otel_sources",
    `UNION ALL SELECT 32, 'otel: reference index count = view count = direct per-file scan of the window', (${direct})::VARCHAR, ` +
      "(SELECT count(*) FROM otel_ref_idx)::VARCHAR || ' index, ' || (SELECT count(*) FROM otel_ref) || ' view', " +
      `(SELECT count(*) FROM otel_ref_idx) = (${direct}) AND (SELECT count(*) FROM otel_ref) = (${direct}) AND (${direct}) > 0`,
    `UNION ALL SELECT 33, 'otel: boundary rows removed by the half-open rule are identical twins in the next file', (${twins})::VARCHAR || ' twins', ` +
      `(SELECT duplicates_removed FROM otel_reference)::VARCHAR || ' removed', (SELECT duplicates_removed FROM otel_reference) = (${twins})`,
    `UNION ALL SELECT 34, 'otel: full-text index @@ ''${term}'' = regex count over the reference window', ` +
      `(SELECT count(*) FROM otel_ref WHERE ${regex})::VARCHAR, (SELECT count(*) FROM otel_ref_idx WHERE message @@ '${term}')::VARCHAR, ` +
      `(SELECT count(*) FROM otel_ref_idx WHERE message @@ '${term}') = (SELECT count(*) FROM otel_ref WHERE ${regex}) AND (SELECT count(*) FROM otel_ref WHERE ${regex}) > 0`,
  ]
}

/** Placeholders of 99_cleanup.sql: the staging tables of the extensions. */
export function cleanupPlaceholders(source: Source): Record<string, string> {
  return { EXTENSION_CLEANUP: sharedPieces(source).EXTENSION_CLEANUP }
}

export async function readSql(file: SqlFile): Promise<string> {
  return readFile(new URL(file, SQL_DIR), "utf8")
}
