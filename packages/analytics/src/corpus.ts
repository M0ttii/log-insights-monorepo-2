import { DATASET_IDS, type Dataset } from "@workspace/domain/datasets"
import { invalidInput, type ToolError } from "@workspace/domain/errors"
import {
  formatInstant,
  parseInstant,
  type DataSpan,
} from "@workspace/domain/time"
import type { QueryRunner } from "@workspace/domain/tool"
import { z } from "zod"

import { QueryFailure } from "./db.ts"
import { isoTime } from "./sql.ts"

/**
 * Reads of the load metadata the loader writes (technical.md § 6.1). Tools
 * use `getDataSpan` instead of building their own span queries.
 */

/** SQLSTATE undefined_table: the corpus was never loaded into this database. */
const UNDEFINED_TABLE = "42P01"

export const corpusNotLoaded: ToolError = {
  code: "db_unavailable",
  message:
    "The corpus is not loaded: this SereneDB database has no load manifest.",
  hint: "Tell the user to run `pnpm data:setup` (or `--samples`) and restart the client; do not retry before that.",
}

const manifestRow = z.object({ data_version: z.string().min(1) })

/** The data version every receipt refers to; `corpusNotLoaded` without a manifest. */
export async function readDataVersion(
  db: QueryRunner,
  signal: AbortSignal
): Promise<
  { ok: true; dataVersion: string } | { ok: false; error: ToolError }
> {
  try {
    const { rows } = await db.query(
      "SELECT data_version FROM load_manifest",
      [],
      signal
    )
    // The loader writes exactly one row, and only after its checks passed.
    if (rows.length !== 1) return { ok: false, error: corpusNotLoaded }
    return { ok: true, dataVersion: manifestRow.parse(rows[0]).data_version }
  } catch (error) {
    if (error instanceof QueryFailure && error.sqlstate === UNDEFINED_TABLE)
      return { ok: false, error: corpusNotLoaded }
    throw error
  }
}

const spanRow = z.object({ first: z.string(), last: z.string() })

/**
 * First and last event time of a dataset over its whole load, from
 * `corpus_stats`; `null` if the dataset has no events. Runs through the
 * tool's runner, so the query appears in the tool's receipt.
 */
export async function getDataSpan(
  db: QueryRunner,
  dataset: Dataset,
  signal: AbortSignal
): Promise<DataSpan | null> {
  const { rows } = await db.query(
    `SELECT ${isoTime("first_ts")} AS first, ${isoTime("last_ts")} AS last FROM corpus_stats WHERE dataset = $1`,
    [dataset],
    signal
  )
  if (rows.length === 0) return null
  return spanRow.parse(rows[0])
}

const datasetRow = z.object({ dataset: z.string() })

/**
 * Datasets of the current load in catalog order (BGL and OpenStack first),
 * from `corpus_stats`. Through the tool's runner, so the query is in the
 * receipt.
 */
export async function loadedDatasets(
  db: QueryRunner,
  signal: AbortSignal
): Promise<Dataset[]> {
  const { rows } = await db.query(
    "SELECT dataset FROM corpus_stats ORDER BY dataset",
    [],
    signal
  )
  const loaded = new Set(rows.map((row) => datasetRow.parse(row).dataset))
  return DATASET_IDS.filter((id) => loaded.has(id))
}

/** A known dataset that this load does not contain (U26). */
export function datasetNotLoaded(
  dataset: Dataset,
  loaded: readonly Dataset[]
): ToolError {
  return invalidInput(
    [
      {
        path: "dataset",
        message: `Dataset ${dataset} is not loaded; loaded: ${loaded.join(", ")}.`,
      },
    ],
    `Use one of ${loaded.join(", ")}, or ask the user to load it with \`pnpm data:setup --with ${dataset}\` and restart the client.`
  )
}

/**
 * The span of a dataset, or the error to return: a dataset missing from a
 * valid load is invalid input naming the loaded datasets, an empty load is
 * `corpusNotLoaded`.
 */
export async function requireDataSpan(
  db: QueryRunner,
  dataset: Dataset,
  signal: AbortSignal
): Promise<{ ok: true; span: DataSpan } | { ok: false; error: ToolError }> {
  const span = await getDataSpan(db, dataset, signal)
  if (span !== null) return { ok: true, span }
  const loaded = await loadedDatasets(db, signal)
  return {
    ok: false,
    error:
      loaded.length === 0 ? corpusNotLoaded : datasetNotLoaded(dataset, loaded),
  }
}

/**
 * Exclusive end of a window that covers a span up to and including its last
 * event: 1 µs after it, because windows are `[from, to)` (R-03).
 */
export function spanEnd(span: DataSpan): string {
  const micros = parseInstant(span.last)
  if (micros === null) throw new RangeError(`not an instant: ${span.last}`)
  return formatInstant(micros + 1n)
}
