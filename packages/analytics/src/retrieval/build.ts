import { readFile } from "node:fs/promises"

import { loadConfig, loadRetrievalConfig } from "../config.ts"
import { readDataVersion } from "../corpus.ts"
import { createDatabase } from "../db.ts"
import {
  buildRetrievalSnapshot,
  embedRetrievalImport,
  retrievalImportSchema,
} from "../retrieval.ts"

const args = process.argv.slice(2)
const embed = args[0] === "--embed"
const file = args[embed ? 1 : 0]
if (file === undefined)
  throw new Error(
    "Usage: pnpm --filter @workspace/analytics retrieval:build [--embed] <config-or-embeddings.json>"
  )
const raw = JSON.parse(await readFile(file, "utf8"))
const db = createDatabase(loadConfig().connection)
const signal = new AbortController().signal
try {
  const retrieval = loadRetrievalConfig()
  if (embed && retrieval.embeddingSecret === undefined)
    throw new Error(
      "--embed requires LOG_INSIGHTS_EMBEDDING_SECRET, naming a configured SereneDB provider secret"
    )
  const imported =
    embed && retrieval.embeddingSecret !== undefined
      ? await embedRetrievalImport(db, raw, retrieval.embeddingSecret, signal)
      : retrievalImportSchema.parse(raw)
  const version = await readDataVersion(db, signal)
  if (!version.ok || version.dataVersion !== imported.data_version)
    throw new Error("Import data_version must match the loaded corpus")
  const snapshot = await buildRetrievalSnapshot(
    db,
    imported,
    loadRetrievalConfig().directory,
    signal
  )
  process.stdout.write(
    `Retrieval snapshot ${snapshot.snapshot_id}; ${snapshot.indexed_events} indexed events.\n`
  )
} finally {
  await db.dispose()
}
