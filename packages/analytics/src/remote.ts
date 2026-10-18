import { REMOTE_SCAN_MAX_FILES } from "@workspace/domain/datasets"
import {
  invalidInput,
  limitExceeded,
  sourceChanged,
  type ToolError,
} from "@workspace/domain/errors"
import type { ReceiptSource } from "@workspace/domain/receipt"
import {
  parseInstant,
  type DataSpan,
  type TimeRange,
} from "@workspace/domain/time"
import type { QueryRunner } from "@workspace/domain/tool"
import { z } from "zod"

import { datasetNotLoaded, loadedDatasets, requireDataSpan } from "./corpus.ts"
import { QueryFailure } from "./db.ts"
import {
  isoNanos,
  otelIndexRelation,
  otelScanRelation,
  parquetLiteral,
  type Relation,
  type ScanFile,
} from "./relations.ts"
import { exactCount, isoTime, SqlParams } from "./sql.ts"

/**
 * Remote Parquet access for the otel dataset (LOG-35, design D3, D4). Reads
 * the tables the loader wrote (otel_sources: allowlisted files with their
 * pins and half-open assigned ranges; otel_row_groups: footer row groups;
 * otel_reference: the indexed reference window), checks the files against
 * their pins before a query, and describes what a run read for its receipt.
 * Every query runs through the tool's runner, so it lands in the receipt.
 */

/** SQLSTATE undefined_table: the otel tables were never loaded here. */
const UNDEFINED_TABLE = "42P01"
/** SQLSTATE connection_exception: SereneDB reports HTTP failures with it. */
const REMOTE_IO = "08000"

const DATASET = "otel"

const nanoText = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/)

const sourceRow = z.object({
  file_index: z.number().int().nonnegative(),
  url: z.string(),
  bytes: exactCount,
  etag: z.string().nullable(),
  last_modified: z.string(),
  assigned_from: nanoText,
  assigned_to: nanoText.nullable(),
})

const referenceRow = z.object({
  index_name: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  source_glob: z.string(),
  window_from: z.string(),
  window_to: z.string(),
  built_at: z.string(),
  build_ms: z.number().nonnegative(),
  events: exactCount,
  duplicates_removed: exactCount,
  mapping_version: z.string(),
})

const referenceFileRow = sourceRow.extend({
  read_from: nanoText,
  read_to: nanoText,
})

export type OtelReference = z.infer<typeof referenceRow> & {
  /**
   * Allowlisted files whose assigned range meets the window, in order, with
   * the part of the window each one holds (read_from, read_to).
   */
  files: z.infer<typeof referenceFileRow>[]
}

const SOURCE_COLUMNS = (q: string) =>
  `${q}.file_index, ${q}.url, ${q}.size AS bytes, ${q}.etag, ${isoTime(`${q}.last_modified`)} AS last_modified, ${isoNanos(`${q}.assigned_from`)} AS assigned_from, ${isoNanos(`${q}.assigned_to`)} AS assigned_to`

/**
 * The reference window with its index and files; null when this database
 * has no otel load (the caller reports the dataset as not loaded).
 */
export async function readReference(
  db: QueryRunner,
  signal: AbortSignal
): Promise<OtelReference | null> {
  try {
    const found = await db.query(
      `SELECT index_name, source_glob, ${isoTime("window_from")} AS window_from, ${isoTime("window_to")} AS window_to, ${isoTime("built_at")} AS built_at, build_ms, events, duplicates_removed, mapping_version FROM otel_reference`,
      [],
      signal
    )
    if (found.rows.length !== 1) return null
    const reference = referenceRow.parse(found.rows[0])
    const params = new SqlParams()
    const from = `${params.add(reference.window_from)}::TIMESTAMPTZ_NS`
    const to = `${params.add(reference.window_to)}::TIMESTAMPTZ_NS`
    const files = await db.query(
      `SELECT ${SOURCE_COLUMNS("s")}, ${isoNanos(`greatest(s.assigned_from, ${from})`)} AS read_from, ${isoNanos(`CASE WHEN s.assigned_to IS NULL THEN ${to} ELSE least(s.assigned_to, ${to}) END`)} AS read_to FROM otel_sources s WHERE s.assigned_from < ${to} AND (s.assigned_to IS NULL OR s.assigned_to > ${from}) ORDER BY s.file_index`,
      params.values,
      signal
    )
    return {
      ...reference,
      files: files.rows.map((row) => referenceFileRow.parse(row)),
    }
  } catch (error) {
    if (error instanceof QueryFailure && error.sqlstate === UNDEFINED_TABLE)
      return null
    throw error
  }
}

/** The index relation of a reference window. */
function referenceRelation(reference: OtelReference): Relation {
  return otelIndexRelation(
    reference.index_name,
    reference.files.map((file) => ({
      file_index: file.file_index,
      from: file.assigned_from,
      to: file.assigned_to,
    }))
  )
}

/**
 * Full text works only inside the indexed reference window (D3.1): the
 * window, defaulting to the reference window, or invalid_input naming the
 * window and the alternatives.
 */
function referenceWindow(
  reference: OtelReference,
  bounds: { from?: string | undefined; to?: string | undefined },
  what: string
): { ok: true; window: TimeRange } | { ok: false; error: ToolError } {
  const window = {
    from: bounds.from ?? reference.window_from,
    to: bounds.to ?? reference.window_to,
  }
  const from = parseInstant(window.from)
  const to = parseInstant(window.to)
  const lower = parseInstant(reference.window_from)
  const upper = parseInstant(reference.window_to)
  if (
    from === null ||
    to === null ||
    lower === null ||
    upper === null ||
    from < lower ||
    to > upper
  )
    return {
      ok: false,
      error: invalidInput(
        [
          {
            path:
              bounds.from !== undefined && (from ?? 0n) < (lower ?? 0n)
                ? "from"
                : "to",
            message: `${what} for dataset ${DATASET} works only inside the indexed reference window [${reference.window_from}, ${reference.window_to}); [${window.from}, ${window.to}) reaches outside it. Outside the window the allowlisted files are read only by bounded direct scans, without full text.`,
          },
        ],
        `Keep from/to inside [${reference.window_from}, ${reference.window_to}) (or leave them out), or drop the text condition and use count_events / event_trend with from/to at most 60 s apart anywhere in the data span.`
      ),
    }
  return { ok: true, window }
}

const scanRow = z.object({
  file_index: z.number().int().nonnegative(),
  url: z.string(),
  bytes: exactCount,
  etag: z.string().nullable(),
  last_modified: z.string(),
  assigned_from: nanoText,
  assigned_to: nanoText.nullable(),
  read_from: nanoText,
  read_to: nanoText,
  estimated_bytes: exactCount,
  estimated_row_groups: exactCount,
})

type ScanSelection = z.infer<typeof scanRow>

/**
 * The allowlisted files a direct scan of [from, to) reads, from
 * otel_sources (D3.2): every file whose half-open assigned range meets the
 * window, with the bounds that apply to it and the footer estimate of the
 * row groups those bounds overlap. SereneDB computes the bounds and the
 * estimate; at most REMOTE_SCAN_MAX_FILES files, else limit_exceeded.
 */
async function selectScanFiles(
  db: QueryRunner,
  window: TimeRange,
  signal: AbortSignal
): Promise<
  { ok: true; files: ScanSelection[] } | { ok: false; error: ToolError }
> {
  const params = new SqlParams()
  const from = `${params.add(window.from)}::TIMESTAMPTZ_NS`
  const to = `${params.add(window.to)}::TIMESTAMPTZ_NS`
  const lower = `greatest(s.assigned_from, ${from})`
  const upper = `CASE WHEN s.assigned_to IS NULL THEN ${to} ELSE least(s.assigned_to, ${to}) END`
  const { rows } = await db.query(
    `WITH picked AS (SELECT s.*, ${lower} AS read_from, ${upper} AS read_to FROM otel_sources s WHERE s.assigned_from < ${to} AND (s.assigned_to IS NULL OR s.assigned_to > ${from})) SELECT ${SOURCE_COLUMNS("p")}, ${isoNanos("p.read_from")} AS read_from, ${isoNanos("p.read_to")} AS read_to, coalesce((SELECT sum(r.compressed_bytes) FROM otel_row_groups r WHERE r.file_index = p.file_index AND r.ts_max >= p.read_from AND r.ts_min < p.read_to), 0)::BIGINT AS estimated_bytes, (SELECT count(*) FROM otel_row_groups r WHERE r.file_index = p.file_index AND r.ts_max >= p.read_from AND r.ts_min < p.read_to) AS estimated_row_groups FROM picked p ORDER BY p.file_index`,
    params.values,
    signal
  )
  const files = rows.map((row) => scanRow.parse(row))
  if (files.length > REMOTE_SCAN_MAX_FILES)
    return {
      ok: false,
      error: {
        ...limitExceeded(
          `Remote files for [${window.from}, ${window.to})`,
          REMOTE_SCAN_MAX_FILES,
          files.length
        ),
        hint: `Narrow from/to so the window touches at most ${REMOTE_SCAN_MAX_FILES} files (files: ${files.map((file) => `part_${String(file.file_index).padStart(3, "0")} from ${file.assigned_from}`).join(", ")}).`,
      },
    }
  return { ok: true, files }
}

/** The relation-ready part of a selection. */
function scanFiles(files: readonly ScanSelection[]): ScanFile[] {
  return files.map(({ file_index, url, read_from, read_to }) => ({
    file_index,
    url,
    read_from,
    read_to,
  }))
}

const checkRow = z.object({
  file_index: z.number().int().nonnegative(),
  url: z.string(),
  unchanged: z.boolean().nullable(),
})

/**
 * Pre-query source check (D4): size and Last-Modified of every file the run
 * reads, from read_blob (one HEAD per file, no body), compared in SQL with
 * the load-time pin in otel_sources. A difference is `source_changed`; an
 * HTTP failure is reported as an unreachable source. SereneDB exposes no
 * ETag, so the ETag is compared only at load.
 */
async function checkSources(
  db: QueryRunner,
  files: readonly { file_index: number; url: string }[],
  signal: AbortSignal
): Promise<ToolError | null> {
  const params = new SqlParams()
  const indexes = params.list(files.map((file) => file.file_index))
  const list = files.map((file) => parquetLiteral(file.url)).join(", ")
  let rows: Record<string, unknown>[]
  try {
    ;({ rows } = await db.query(
      `SELECT s.file_index, s.url, (b.size IS NOT DISTINCT FROM s.size AND b.last_modified IS NOT DISTINCT FROM s.last_modified) AS unchanged FROM otel_sources s LEFT JOIN read_blob([${list}]) b ON b.filename = s.url WHERE s.file_index IN (${indexes}) ORDER BY s.file_index`,
      params.values,
      signal
    ))
  } catch (error) {
    if (error instanceof QueryFailure && error.sqlstate === REMOTE_IO)
      return {
        code: "db_unavailable",
        message: `A remote file of dataset ${DATASET} could not be checked (HTTP error or no network), so it was not queried.`,
        hint: `Tell the user the remote source is unreachable. If the file was removed or renamed, \`pnpm data:setup --with ${DATASET}\` must reload the dataset.`,
      }
    throw error
  }
  const checked = rows.map((row) => checkRow.parse(row))
  const changed = files
    .filter(
      (file) =>
        checked.find((row) => row.file_index === file.file_index)?.unchanged !==
        true
    )
    .map((file) => file.url)
  return changed.length === 0 ? null : sourceChanged(DATASET, changed)
}

const NOT_MEASURED =
  "SereneDB reports remote bytes only under EXPLAIN ANALYZE; normal tool queries are not instrumented."

/** Receipt `source` of a direct scan. */
function scanSource(
  window: TimeRange,
  files: readonly ScanSelection[],
  mappingVersion: string
): ReceiptSource {
  return {
    dataset: DATASET,
    kind: "remote_parquet",
    path: "direct_scan",
    window,
    files: files.map((file) => ({
      file_index: file.file_index,
      url: file.url,
      bytes: file.bytes,
      etag: file.etag,
      last_modified: file.last_modified,
      assigned_from: file.assigned_from,
      assigned_to: file.assigned_to,
      read_from: file.read_from,
      read_to: file.read_to,
    })),
    mapping_version: mappingVersion,
    index: null,
    source_check: {
      method: "read_blob size and last_modified",
      files_checked: files.length,
    },
    bytes_read: { kind: "not_measured", reason: NOT_MEASURED },
    bytes_estimated_from_footer: {
      kind: "estimate",
      bytes: files.reduce((sum, file) => sum + file.estimated_bytes, 0),
      row_groups: files.reduce(
        (sum, file) => sum + file.estimated_row_groups,
        0
      ),
      basis:
        "Upper bound: compressed size of every column of the Parquet row groups whose Timestamp statistics overlap the per-file bounds (footers read at load); the reader fetches only the columns a query needs.",
    },
  }
}

/** Receipt `source` of a run on the reference index. */
function referenceSource(
  window: TimeRange,
  reference: OtelReference
): ReceiptSource {
  return {
    dataset: DATASET,
    kind: "remote_parquet",
    path: "indexed_window",
    window,
    files: reference.files.map((file) => ({
      file_index: file.file_index,
      url: file.url,
      bytes: file.bytes,
      etag: file.etag,
      last_modified: file.last_modified,
      assigned_from: file.assigned_from,
      assigned_to: file.assigned_to,
      // The part of the reference window the index holds of this file.
      read_from: file.read_from,
      read_to: file.read_to,
    })),
    mapping_version: reference.mapping_version,
    index: {
      name: reference.index_name,
      glob: reference.source_glob,
      from: reference.window_from,
      to: reference.window_to,
      built_at: reference.built_at,
      build_ms: reference.build_ms,
    },
    source_check: {
      method: "read_blob size and last_modified",
      files_checked: reference.files.length,
    },
    bytes_read: { kind: "not_measured", reason: NOT_MEASURED },
    bytes_estimated_from_footer: null,
  }
}

/** Notes every otel result carries. */
export function remoteNotes(path: "indexed_window" | "direct_scan"): string[] {
  return path === "direct_scan"
    ? [
        "otel is read in place from remote Parquet files: this count is exact over the queried window only, never over the whole dataset; rows on a file boundary are counted once (half-open assigned ranges).",
        "Times are truncated to microseconds in outputs; filters compare the nanosecond Timestamp exactly.",
      ]
    : [
        "otel full text runs on the indexed reference window only (a snapshot built at load, see the receipt source); the counts are exact over that window, never over the whole dataset; rows on the file boundary are counted once.",
        "Times are truncated to microseconds in outputs; filters compare the nanosecond Timestamp exactly.",
      ]
}

export type OpenedReference = {
  rel: Relation
  window: { dataset: "otel"; from: string; to: string }
  source: ReceiptSource
  reference: OtelReference
}

/**
 * Everything a full-text run on otel needs (D3.1): the dataset is loaded,
 * the window lies inside the reference window, the reference files still
 * match their pins; then the index relation and the receipt source.
 */
export async function openReference(
  db: QueryRunner,
  bounds: { from?: string | undefined; to?: string | undefined },
  what: string,
  signal: AbortSignal
): Promise<
  { ok: true; opened: OpenedReference } | { ok: false; error: ToolError }
> {
  const required = await requireDataSpan(db, DATASET, signal)
  if (!required.ok) return required
  const reference = await readReference(db, signal)
  if (reference === null || reference.files.length === 0)
    return {
      ok: false,
      error: datasetNotLoaded(DATASET, await loadedDatasets(db, signal)),
    }
  const resolved = referenceWindow(reference, bounds, what)
  if (!resolved.ok) return resolved
  const changed = await checkSources(db, reference.files, signal)
  if (changed !== null) return { ok: false, error: changed }
  return {
    ok: true,
    opened: {
      rel: referenceRelation(reference),
      window: { dataset: DATASET, ...resolved.window },
      source: referenceSource(resolved.window, reference),
      reference,
    },
  }
}

export type OpenedScan = {
  files: ScanSelection[]
  span: DataSpan
  window: { dataset: "otel"; from: string; to: string }
  source: ReceiptSource
  /** The scan relation, bound into the statement that owns `params`. */
  relation(params: SqlParams): Relation
}

const mappingRow = z.object({ mapping_version: z.string() })

/**
 * Everything a bounded direct scan needs (D3.2): the dataset is loaded, the
 * window meets its data span, at most REMOTE_SCAN_MAX_FILES allowlisted
 * files are touched and each still matches its pin.
 */
export async function openScan(
  db: QueryRunner,
  window: TimeRange,
  signal: AbortSignal
): Promise<{ ok: true; opened: OpenedScan } | { ok: false; error: ToolError }> {
  const required = await requireDataSpan(db, DATASET, signal)
  if (!required.ok) return required
  const { span } = required
  const from = parseInstant(window.from)
  const to = parseInstant(window.to)
  const first = parseInstant(span.first)
  const last = parseInstant(span.last)
  if (
    from === null ||
    to === null ||
    first === null ||
    last === null ||
    to <= first ||
    from > last
  )
    return {
      ok: false,
      error: invalidInput(
        [
          {
            path: "from",
            message: `[${window.from}, ${window.to}) lies outside the ${DATASET} data span (${span.first} to ${span.last}); no file covers it, which is not a zero.`,
          },
        ],
        `Choose from/to inside ${span.first} to ${span.last}, at most 60 s apart.`
      ),
    }
  const selected = await selectScanFiles(db, window, signal)
  if (!selected.ok) return selected
  const { files } = selected
  if (files.length === 0)
    return {
      ok: false,
      error: datasetNotLoaded(DATASET, await loadedDatasets(db, signal)),
    }
  const mapping = await db.query(
    "SELECT mapping_version FROM otel_reference",
    [],
    signal
  )
  const mappingVersion = mappingRow.parse(mapping.rows[0]).mapping_version
  const changed = await checkSources(db, files, signal)
  if (changed !== null) return { ok: false, error: changed }
  return {
    ok: true,
    opened: {
      files,
      span,
      window: { dataset: DATASET, ...window },
      source: scanSource(window, files, mappingVersion),
      relation: (params) => otelScanRelation(scanFiles(files), params),
    },
  }
}
