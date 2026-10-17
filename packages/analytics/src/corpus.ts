import type { ToolError } from "@workspace/domain/errors"
import type { Dataset } from "@workspace/domain/filters"
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

/**
 * Exclusive end of a window that covers a span up to and including its last
 * event: 1 µs after it, because windows are `[from, to)` (R-03).
 */
export function spanEnd(span: DataSpan): string {
  const micros = parseInstant(span.last)
  if (micros === null) throw new RangeError(`not an instant: ${span.last}`)
  return formatInstant(micros + 1n)
}
