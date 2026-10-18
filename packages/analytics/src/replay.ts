import type { ToolError } from "@workspace/domain/errors"
import type { ReceiptSource } from "@workspace/domain/receipt"
import type { DataSpan } from "@workspace/domain/time"
import type { QueryRunner } from "@workspace/domain/tool"
import { z } from "zod"

import { datasetNotLoaded, loadedDatasets, requireDataSpan } from "./corpus.ts"
import { QueryFailure } from "./db.ts"
import { otelReplayRelation, type Relation } from "./relations.ts"
import { exactCount, isoTime } from "./sql.ts"

/**
 * The OTLP replay dataset otel_replay (LOG-35, design D7): the loader posts
 * a committed fixture of public text_bench records to SereneDB's own
 * OTLP/HTTP listener and indexes this replay (corpus/sql/63). Tools read the
 * index snapshot; otel_replay records which replay, fixture and listener
 * table it holds, for receipts and describe_corpus.
 */

const DATASET = "otel_replay"

/** SQLSTATE undefined_table: no replay in this database. */
const UNDEFINED_TABLE = "42P01"

const replayRow = z.object({
  replay_id: z.string(),
  replayed_at: z.string(),
  records: exactCount,
  fixture_path: z.string(),
  fixture_sha256: z.string(),
  source_url: z.string(),
  listener_table: z.string(),
  index_name: z.string(),
  index_built_at: z.string(),
})

export type ReplayFacts = z.infer<typeof replayRow>

/** The replay of this load; null when the database has none. */
export async function readReplay(
  db: QueryRunner,
  signal: AbortSignal
): Promise<ReplayFacts | null> {
  try {
    const { rows } = await db.query(
      `SELECT replay_id, ${isoTime("replayed_at")} AS replayed_at, records, fixture_path, fixture_sha256, source_url, listener_table, index_name, ${isoTime("index_built_at")} AS index_built_at FROM otel_replay`,
      [],
      signal
    )
    return rows.length === 1 ? replayRow.parse(rows[0]) : null
  } catch (error) {
    if (error instanceof QueryFailure && error.sqlstate === UNDEFINED_TABLE)
      return null
    throw error
  }
}

function replaySource(replay: ReplayFacts): ReceiptSource {
  return {
    dataset: DATASET,
    kind: "otlp_replay",
    replay_id: replay.replay_id,
    replayed_at: replay.replayed_at,
    records: replay.records,
    fixture: {
      path: replay.fixture_path,
      sha256: replay.fixture_sha256,
      source_url: replay.source_url,
    },
    listener_table: replay.listener_table,
    index: { name: replay.index_name, built_at: replay.index_built_at },
  }
}

/** Notes every otel_replay result carries. */
export function replayNotes(replay: {
  records: number
  replayed_at: string
  replay_id: string
}): string[] {
  return [
    `otel_replay is a replay, not a production stream: ${replay.records} public text_bench records posted once at ${replay.replayed_at} (replay ${replay.replay_id}) to SereneDB's OTLP listener; counts are exact over these records only.`,
    "Times are the original record times (UTC), truncated to microseconds in outputs; observed_timestamp is the replay time.",
  ]
}

export type OpenedReplay = {
  rel: Relation
  span: DataSpan
  source: ReceiptSource
  replay: ReplayFacts
}

/** The replay relation with its span and receipt source, or the error to return. */
export async function openReplay(
  db: QueryRunner,
  signal: AbortSignal
): Promise<
  { ok: true; opened: OpenedReplay } | { ok: false; error: ToolError }
> {
  const required = await requireDataSpan(db, DATASET, signal)
  if (!required.ok) return required
  const replay = await readReplay(db, signal)
  if (replay === null)
    return {
      ok: false,
      error: datasetNotLoaded(DATASET, await loadedDatasets(db, signal)),
    }
  return {
    ok: true,
    opened: {
      rel: otelReplayRelation(),
      span: required.span,
      source: replaySource(replay),
      replay,
    },
  }
}
