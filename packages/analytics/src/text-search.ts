import type { QueryRunner } from "@workspace/domain/tool"
import { z } from "zod"

/**
 * Full-text building blocks shared by search_logs and get_log_context.
 * Queries are split with the index dictionary, so "no searchable word"
 * follows SereneDB, not a guess in TypeScript (gate G4, G10).
 */

/** Index relation and text dictionary created by corpus/sql/50_index.sql. */
export const INDEX = "log_events_idx"
const DICTIONARY = "log_text"

const TOKENIZE_SQL = `SELECT to_json(ts_lexize('${DICTIONARY}', $1)) AS tokens`

const tokensRow = z.object({ tokens: z.array(z.string()) })

/** The index terms of `query`; runs through the tool's runner, so it lands in the receipt. */
export async function tokenize(
  db: QueryRunner,
  query: string,
  signal: AbortSignal
): Promise<string[]> {
  const { rows } = await db.query(TOKENIZE_SQL, [query], signal)
  return tokensRow.parse(rows[0]).tokens
}

export const NO_SEARCHABLE_WORD =
  "Contains no searchable word: spaces and punctuation alone are not indexed."
export const NO_SEARCHABLE_WORD_HINT =
  "Search for at least one word or number from the log message."
