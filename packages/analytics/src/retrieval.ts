import { createHash, randomUUID } from "node:crypto"
import {
  link,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"

import { DATASET_COLUMNS, type Dataset } from "@workspace/domain/datasets"
import { invalidInput, sourceChanged } from "@workspace/domain/errors"
import { remoteScanError, validateFilter } from "@workspace/domain/filters"
import { SEARCH_FILTER } from "@workspace/domain/tools/search-logs"
import {
  canonicalJson,
  receiptSourceSchema,
  type ReceiptSource,
  type Scope,
} from "@workspace/domain/receipt"
import { instantSchema, parseInstant } from "@workspace/domain/time"
import type { QueryRunner, ToolContext } from "@workspace/domain/tool"
import { z } from "zod"

import { loadRetrievalConfig } from "./config.ts"
import { QueryFailure } from "./db.ts"
import { readDataVersion } from "./corpus.ts"
import { resultDigest } from "./receipts.ts"
import { compileFilter } from "./filters.ts"
import { SqlParams, exactCount } from "./sql.ts"
import {
  logEventsRelation,
  otelReplayRelation,
  parquetLiteral,
  type Relation,
} from "./relations.ts"
import { openReference, openScan } from "./remote.ts"
import { openReplay } from "./replay.ts"
import { resolveWindows } from "./scope.ts"

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const vector = z.array(z.number().finite()).min(1).max(4096)
const metadata = {
  provider: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  model_version: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (value) => !["latest", "default"].includes(value.toLowerCase()),
      "Provide an explicit embedding model revision label"
    ),
  dimensions: z.number().int().min(1).max(4096),
  normalization: z.enum(["none", "l2"]),
  preprocessing_version: z.literal("message-v1"),
  data_version: z.string().min(1),
}
const queryEmbedding = z.strictObject({
  query: z.string().min(1).max(200),
  embedding: vector,
})
const sourceSelectionSchema = z.discriminatedUnion("dataset", [
  z.strictObject({
    dataset: z.literal("otel"),
    path: z.enum(["direct_scan", "indexed_window"]),
    from: instantSchema.optional(),
    to: instantSchema.optional(),
  }),
  z.strictObject({
    dataset: z.literal("otel_replay"),
    from: instantSchema.optional(),
    to: instantSchema.optional(),
  }),
])
const sourceWindowSchema = z.strictObject({
  dataset: z.enum(["otel", "otel_replay"]),
  from: instantSchema,
  to: instantSchema,
})
type SourceSelection = z.infer<typeof sourceSelectionSchema>
type SourceWindow = z.infer<typeof sourceWindowSchema>
type BuildSource = {
  source?: ReceiptSource
  window?: SourceWindow
  relation(params: SqlParams): Relation
}

/** Embeddings are supplied by a named provider/model; there is no fabricated default. */
export const retrievalImportSchema = z.strictObject({
  version: z.literal(1),
  ...metadata,
  source: sourceSelectionSchema.optional(),
  events: z
    .array(
      z.strictObject({
        event_id: z.number().int().nonnegative().safe(),
        message_sha256: digestSchema,
        embedding: vector,
      })
    )
    .min(1)
    .max(50_000),
  queries: z.array(queryEmbedding).max(10_000).default([]),
})
export type RetrievalImport = z.infer<typeof retrievalImportSchema>
const manifestPayloadSchema = z.strictObject({
  version: z.literal(1),
  ...metadata,
  source: receiptSourceSchema.optional(),
  source_window: sourceWindowSchema.optional(),
  events_digest: digestSchema,
  indexed_events: z.number().int().positive(),
  queries: z.array(queryEmbedding).max(10_000),
})
const manifestSchema = manifestPayloadSchema.extend({
  snapshot_id: digestSchema,
})
type Manifest = z.infer<typeof manifestSchema>

export function retrievalDigest(value: unknown): string {
  return resultDigest(value)
}
export function messageDigest(message: string | null): string {
  return createHash("sha256")
    .update(message ?? "")
    .digest("hex")
}
const tableName = (id: string) =>
  `log_retrieval_${digestSchema.parse(id).slice(0, 32)}`

/** A snapshot owns only its table/index; no corpus relation is modified. */
export async function buildRetrievalSnapshot(
  db: QueryRunner,
  raw: unknown,
  directory: string,
  signal: AbortSignal
): Promise<Manifest> {
  const imported = retrievalImportSchema.parse(raw)
  const ids = new Set<number>()
  const queries = new Set<string>()
  for (const event of imported.events) {
    if (ids.has(event.event_id)) throw new Error("Duplicate retrieval event ID")
    ids.add(event.event_id)
    checkVector(event.embedding, imported)
  }
  for (const query of imported.queries) {
    if (queries.has(query.query)) throw new Error("Duplicate retrieval query")
    queries.add(query.query)
    checkVector(query.embedding, imported)
  }
  const version = await readDataVersion(db, signal)
  if (!version.ok || version.dataVersion !== imported.data_version)
    throw new Error("Import data_version must match the loaded corpus")
  const { events, source: selection, ...rest } = imported
  const openedSource = await openBuildSource(db, selection, signal)
  const payload = manifestPayloadSchema.parse({
    ...rest,
    ...(openedSource.source === undefined
      ? {}
      : { source: openedSource.source, source_window: openedSource.window }),
    events_digest: retrievalDigest(events),
    indexed_events: events.length,
  })
  const snapshotId = retrievalDigest(payload)
  const manifest = { ...payload, snapshot_id: snapshotId }
  const table = tableName(snapshotId)
  await mkdir(directory, { recursive: true })
  // Serialize builders across processes sharing the persisted snapshot directory.
  // A stale lock is never stolen: doing so could destroy another live builder.
  const lockPath = join(directory, `${snapshotId}.build.lock`)
  const lock = await acquireBuildLock(lockPath, signal)
  let createdTable = false
  let createdDictionary = false
  let createdIndex = false
  try {
    const manifestPath = join(directory, `${snapshotId}.json`)
    const importPath = join(directory, `${snapshotId}.import.json`)
    await validateExistingFile(manifestPath, manifest)
    await validateExistingFile(importPath, imported)
    // Validate the supplied vectors against the current source even when the
    // manifest survived a database volume reset or the index already exists.
    for (let offset = 0; offset < events.length; offset += 100) {
      const batch = events.slice(offset, offset + 100)
      const sourceParams = new SqlParams()
      const sourceRel = openedSource.relation(sourceParams)
      const originals =
        selection === undefined
          ? await db.query(
              `SELECT event_id, message FROM log_events WHERE event_id IN (${batch.map((_event, index) => `$${index + 1}::BIGINT`).join(", ")}) ORDER BY event_id`,
              batch.map((event) => event.event_id),
              signal
            )
          : await db.query(
              `SELECT ${sourceRel.col("event_id")} AS event_id, ${sourceRel.col("message")} AS message FROM ${sourceRel.from} WHERE ${sourceRel.col("event_id")} IN (${batch.map((event) => `${sourceParams.add(event.event_id)}::BIGINT`).join(", ")}) AND ${sourceWhere(openedSource, sourceRel, sourceParams)} ORDER BY ${sourceRel.col("event_id")}`,
              sourceParams.values,
              signal
            )
      const sourceRows = originals.rows.map((row) =>
        z
          .object({ event_id: exactCount, message: z.string().nullable() })
          .parse(row)
      )
      if (
        sourceRows.length !== batch.length ||
        sourceRows.some(
          (row) =>
            batch.find((event) => event.event_id === row.event_id)
              ?.message_sha256 !== messageDigest(row.message)
        )
      )
        throw new Error(
          "Source message mismatch: rebuild embeddings from this data version"
        )
    }
    const indexed = await relationCount(db, `${table}_idx`, signal)
    if (indexed !== null && indexed !== events.length)
      throw new Error("Published snapshot index is incomplete")
    if (indexed === null) {
      const stored = await relationCount(db, table, signal)
      if (stored !== null && stored !== events.length)
        throw new Error("Snapshot source table is incomplete")
      // A missing index may leave its owned table/dictionary intact. Preserve
      // those objects and recreate only the missing representation pieces.
      try {
        await db.query(
          `CREATE TEXT SEARCH DICTIONARY ${table}_text AS split_text_icu('en_US.UTF-8') | normalize_tokens('en_US.UTF-8', case := 'lower') WITH (frequency, position, norm)`,
          [],
          signal
        )
        createdDictionary = true
      } catch (error) {
        if (!(
          error instanceof QueryFailure &&
          ["42710", "42P07"].includes(error.sqlstate ?? "")
        ))
          throw error
      }
      if (stored === null) {
        const shapeParams = new SqlParams()
        const shapeRel = openedSource.relation(shapeParams)
        await db.query(
          selection === undefined
            ? `CREATE TABLE ${table} AS SELECT *, NULL::FLOAT[${imported.dimensions}] AS embedding FROM log_events WHERE FALSE`
            : `CREATE TABLE ${table} AS SELECT ${normalizedColumns(shapeRel)}, NULL::FLOAT[${imported.dimensions}] AS embedding FROM ${shapeRel.from} WHERE FALSE`,
          shapeParams.values,
          signal
        )
        createdTable = true
        for (let offset = 0; offset < events.length; offset += 100) {
          const batch = events.slice(offset, offset + 100)
          const params = batch.flatMap((event) => [
            event.event_id,
            JSON.stringify(event.embedding),
          ])
          const values = batch
            .map(
              (_event, index) =>
                `($${index * 2 + 1}::BIGINT, $${index * 2 + 2}::FLOAT[${imported.dimensions}])`
            )
            .join(", ")
          if (selection === undefined) {
            await db.query(
              `INSERT INTO ${table} SELECT l.*, v.embedding FROM log_events l JOIN (VALUES ${values}) AS v(event_id, embedding) ON l.event_id = v.event_id`,
              params,
              signal
            )
          } else {
            const remoteParams = new SqlParams()
            const remoteRel = openedSource.relation(remoteParams)
            const remoteValues = batch
              .map(
                (event) =>
                  `(${remoteParams.add(event.event_id)}::BIGINT, ${remoteParams.add(JSON.stringify(event.embedding))}::FLOAT[${imported.dimensions}])`
              )
              .join(", ")
            await db.query(
              `INSERT INTO ${table} SELECT ${normalizedColumns(remoteRel)}, v.embedding FROM ${remoteRel.from} JOIN (VALUES ${remoteValues}) AS v(event_id, embedding) ON ${remoteRel.col("event_id")} = v.event_id WHERE ${sourceWhere(openedSource, remoteRel, remoteParams)}`,
              remoteParams.values,
              signal
            )
          }
        }
      }
      await db.query(
        `CREATE INDEX ${table}_idx ON ${table} USING inverted (dataset, source_file, component, level, source_type, node, rack, midplane, alert_label, request_id, instance_id, endpoint, host, process_id, client_ip, thread, block_id, pattern_id, ${selection === undefined ? "" : "trace_id, span_id, severity_number, "}message ${table}_text, embedding ivf (metric = 'cosine', quant = 'none'))`,
        [],
        signal
      )
      createdIndex = true
      await db.query(`VACUUM (REFRESH_TABLE) ${table}`, [], signal)
      if ((await relationCount(db, `${table}_idx`, signal)) !== events.length)
        throw new Error("Snapshot row count mismatch")
    }
    // Preserve all vectors for a reproducible restore after a database reset.
    // No backend identity is inferred from declared provider/model labels.
    await publishImmutableOrMatch(importPath, imported)
    await publishImmutableOrMatch(manifestPath, manifest)
    return manifest
  } catch (error) {
    // The shared-directory lock serializes ordinary builders. A builder using
    // another artifact directory may still have completed the same DB index:
    // preserve any complete representation before cleaning up our partial work.
    const preserveComplete =
      (createdTable || createdDictionary) &&
      (await relationCount(db, `${table}_idx`, signal).catch(() => null)) ===
        events.length
    if (createdTable && !preserveComplete)
      await db
        .query(`DROP TABLE IF EXISTS ${table} CASCADE`, [], signal)
        .catch(() => undefined)
    if (
      createdDictionary &&
      !preserveComplete &&
      (createdTable || !createdIndex)
    )
      await db
        .query(
          `DROP TEXT SEARCH DICTIONARY IF EXISTS ${table}_text`,
          [],
          signal
        )
        .catch(() => undefined)
    throw error
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}

async function relationCount(
  db: QueryRunner,
  relation: string,
  signal: AbortSignal
): Promise<number | null> {
  try {
    const result = await db.query(
      `SELECT count(*) AS total FROM ${relation}`,
      [],
      signal
    )
    return z.object({ total: exactCount }).parse(result.rows[0]).total
  } catch (error) {
    if (error instanceof QueryFailure && error.sqlstate === "42P01") return null
    throw error
  }
}

async function acquireBuildLock(path: string, signal: AbortSignal) {
  const deadline = Date.now() + 30_000
  for (;;) {
    signal.throwIfAborted()
    try {
      return await open(path, "wx", 0o600)
    } catch (error) {
      if (!isExists(error)) throw error
      if (Date.now() >= deadline)
        throw new Error(
          "Retrieval snapshot is being built; retry after the builder finishes (remove a stale build.lock only after confirming no builder is running)",
          { cause: error }
        )
      await setTimeout(25, undefined, { signal })
    }
  }
}

async function validateExistingFile(
  path: string,
  value: unknown
): Promise<void> {
  try {
    if (
      canonicalJson(JSON.parse(await readFile(path, "utf8"))) !==
      canonicalJson(value)
    )
      throw new Error("Persisted retrieval snapshot content mismatch")
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

async function publishImmutableOrMatch(
  path: string,
  value: unknown
): Promise<void> {
  try {
    await publishImmutable(path, `${canonicalJson(value)}\n`)
  } catch (error) {
    if (!isExists(error)) throw error
    await validateExistingFile(path, value)
  }
}

const SNAPSHOT_COLUMNS = [
  "event_id",
  "dataset",
  ...DATASET_COLUMNS,
  "is_alert",
  "pattern_id",
  "pattern",
] as const
function normalizedColumns(rel: Relation): string {
  return [
    "NULL::VARCHAR AS source_file",
    ...SNAPSHOT_COLUMNS.map((column) => `${rel.col(column)} AS ${column}`),
  ].join(", ")
}
function sourceWhere(
  opened: BuildSource,
  rel: Relation,
  params: SqlParams
): string {
  if (opened.window === undefined) return "TRUE"
  const compiled = compileFilter(opened.window, {
    accepted: SEARCH_FILTER.fields,
    params,
    relation: rel,
  })
  if (!compiled.ok) throw new Error("Invalid snapshot source window")
  return compiled.filter.where
}
async function openBuildSource(
  db: QueryRunner,
  selection: SourceSelection | undefined,
  signal: AbortSignal
): Promise<BuildSource> {
  if (selection === undefined) return { relation: () => logEventsRelation() }
  const invalid = validateFilter(selection)
  if (invalid !== null) throw new Error(invalid.message)
  if (selection.dataset === "otel_replay") {
    const replay = await openReplay(db, signal)
    if (!replay.ok) throw new Error(replay.error.message)
    const resolved = await resolveWindows(
      db,
      ["otel_replay"],
      selection,
      signal
    )
    if (!resolved.ok) throw new Error(resolved.error.message)
    const window = sourceWindowSchema.parse(resolved.windows[0]?.window)
    return {
      source: replay.opened.source,
      window,
      relation: () => replay.opened.rel,
    }
  }
  if (selection.path === "direct_scan") {
    const invalidScan = remoteScanError(selection)
    if (invalidScan !== null) throw new Error(invalidScan.message)
    if (selection.from === undefined || selection.to === undefined)
      throw new Error("Direct snapshots require from/to")
    const scan = await openScan(
      db,
      { from: selection.from, to: selection.to },
      signal
    )
    if (!scan.ok) throw new Error(scan.error.message)
    return {
      source: scan.opened.source,
      window: scan.opened.window,
      relation: scan.opened.relation,
    }
  }
  const reference = await openReference(
    db,
    selection,
    "Retrieval snapshot build",
    signal
  )
  if (!reference.ok) throw new Error(reference.error.message)
  return {
    source: reference.opened.source,
    window: reference.opened.window,
    relation: () => reference.opened.rel,
  }
}

async function checkPinnedSource(ctx: ToolContext, source: ReceiptSource) {
  if (source.kind !== "remote_parquet") return null
  for (const file of source.files) {
    try {
      const checked = await ctx.db.query(
        `SELECT (size IS NOT DISTINCT FROM $1::BIGINT AND last_modified IS NOT DISTINCT FROM $2::TIMESTAMPTZ) AS unchanged FROM read_blob([${parquetLiteral(file.url)}])`,
        [file.bytes, file.last_modified],
        ctx.signal
      )
      if (
        checked.rows.length !== 1 ||
        z.object({ unchanged: z.boolean().nullable() }).parse(checked.rows[0])
          .unchanged !== true
      )
        return sourceChanged(source.dataset, [file.url])
    } catch (error) {
      if (error instanceof QueryFailure && error.sqlstate === "08000")
        return {
          code: "db_unavailable" as const,
          message: "The pinned remote source could not be checked.",
          hint: "Retry when the pinned source is reachable; no retrieval fallback was run.",
        }
      throw error
    }
  }
  return null
}

function checkVector(
  embedding: readonly number[],
  model: Pick<Manifest, "dimensions" | "normalization">
): void {
  if (
    embedding.length !== model.dimensions ||
    embedding.every((value) => value === 0)
  )
    throw new Error("Invalid embedding dimensions or zero vector")
  // Representation validation only; no analytical value is computed here.
  if (
    model.normalization === "l2" &&
    Math.abs(embedding.reduce((sum, value) => sum + value * value, 0) - 1) >
      0.001
  )
    throw new Error("Embedding does not satisfy declared l2 normalization")
}
function withoutId({ snapshot_id: _id, ...payload }: Manifest) {
  return payload
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST"
}

/** Exact vectors are pinned; provider/model labels are declared provenance, not verified backend identities. */
export async function openRetrieval(
  ctx: ToolContext,
  snapshotId: string,
  query: string,
  requested: { dataset?: Dataset; from?: string; to?: string } = {}
) {
  const config = loadRetrievalConfig()
  let manifest: Manifest
  try {
    manifest = manifestSchema.parse(
      JSON.parse(
        await readFile(
          join(config.directory, `${digestSchema.parse(snapshotId)}.json`),
          "utf8"
        )
      )
    )
    if (
      manifest.snapshot_id !== snapshotId ||
      retrievalDigest(withoutId(manifest)) !== snapshotId ||
      manifest.data_version !== ctx.dataVersion
    )
      return unavailable(
        "Snapshot is invalid or belongs to another data version."
      )
    for (const item of manifest.queries) checkVector(item.embedding, manifest)
  } catch (error) {
    if (ctx.signal.aborted) throw error
    return unavailable("Pinned representation is unavailable or invalid.")
  }
  const external = manifest.source
  let windows: Scope["windows"] | undefined
  if (external === undefined) {
    if (requested.dataset === "otel" || requested.dataset === "otel_replay")
      return unavailable(
        "This representation contains log_events datasets, not the requested external dataset."
      )
  } else {
    const pinned = manifest.source_window
    if (
      pinned === undefined ||
      pinned.dataset !== external.dataset ||
      requested.dataset !== pinned.dataset
    )
      return unavailable(
        "Name the exact external dataset of this representation; datasets cannot be mixed."
      )
    const from = requested.from ?? pinned.from
    const to = requested.to ?? pinned.to
    const lower = parseInstant(pinned.from)
    const upper = parseInstant(pinned.to)
    const start = parseInstant(from)
    const end = parseInstant(to)
    if (
      lower === null ||
      upper === null ||
      start === null ||
      end === null ||
      start < lower ||
      end > upper ||
      start >= end
    )
      return unavailable(
        `Requested window must remain inside the pinned representation [${pinned.from}, ${pinned.to}).`
      )
    windows = [{ dataset: pinned.dataset, from, to }]
    const checked = await checkPinnedSource(ctx, external)
    if (checked !== null) return { ok: false as const, error: checked }
  }
  const embedding = manifest.queries.find(
    (item) => item.query === query
  )?.embedding
  if (embedding === undefined)
    return unavailable(
      "No imported query embedding exists for this exact query. Rebuild a snapshot with the query included; a runtime provider secret cannot establish compatibility with stored vectors."
    )

  try {
    checkVector(embedding, manifest)
  } catch {
    return unavailable("Query embedding does not match the pinned model.")
  }
  const base =
    external === undefined
      ? logEventsRelation({ indexed: true })
      : otelReplayRelation()
  const name = `${tableName(snapshotId)}_idx`
  const rel: Relation = {
    ...base,
    q: name,
    from: name,
    dataset:
      external === undefined ? null : (manifest.source_window?.dataset ?? null),
    col: (column) =>
      external === undefined
        ? base.col(column).replaceAll(base.q, name)
        : `${name}.${column}`,
    countRows: `count(${name}.ts)`,
    bucket: (unit) => base.bucket(unit).replaceAll(base.q, name),
  }
  return {
    ok: true as const,
    manifest,
    embedding,
    rel,
    queryDigest: retrievalDigest(embedding),
    ...(external === undefined ? {} : { source: external }),
    ...(windows === undefined ? {} : { windows }),
  }
}

function unavailable(message: string) {
  return {
    ok: false as const,
    error: invalidInput(
      [{ path: "retrieval_snapshot", message }],
      "Build/import a new pinned representation with retrieval:build that includes this exact query vector (or include the query in an offline --embed build); lexical search remains available via match terms, phrase or fuzzy. No lexical fallback was run."
    ),
  }
}

/** Hard-link publication exposes complete bytes and never replaces an existing vector. */
async function publishImmutable(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 })
  try {
    await link(temporary, path)
  } finally {
    await unlink(temporary)
  }
}

const embeddingBuildSchema = z.strictObject({
  version: z.literal(1),
  ...metadata,
  source: sourceSelectionSchema.optional(),
  selection: z.strictObject({
    ...SEARCH_FILTER.shape,
    event_ids: z
      .array(z.number().int().nonnegative().safe())
      .min(1)
      .max(50_000)
      .optional(),
    limit: z.number().int().min(1).max(50_000).default(100),
  }),
  queries: z.array(z.string().min(1).max(200)).max(1000).default([]),
})

/** Explicit offline build step: each provider call has the normal query timeout, no retries. */
export async function embedRetrievalImport(
  db: QueryRunner,
  raw: unknown,
  secret: string,
  signal: AbortSignal
): Promise<RetrievalImport> {
  const config = embeddingBuildSchema.parse(raw)
  const { selection, queries, source, ...meta } = config
  const selectedSource: SourceSelection | undefined =
    source ??
    (selection.dataset === "otel"
      ? {
          dataset: "otel",
          path: "indexed_window",
          ...selectionBounds(selection),
        }
      : selection.dataset === "otel_replay"
        ? { dataset: "otel_replay", ...selectionBounds(selection) }
        : undefined)
  if (
    selectedSource !== undefined &&
    selection.dataset !== undefined &&
    selection.dataset !== selectedSource.dataset
  )
    throw new Error("Embedding selection dataset must match its source")
  if (validateFilter(selection) !== null)
    throw new Error("Invalid retrieval build selection")
  const version = await readDataVersion(db, signal)
  if (!version.ok || version.dataVersion !== meta.data_version)
    throw new Error("Build data_version must match the loaded corpus")
  const opened = await openBuildSource(db, selectedSource, signal)
  const params = new SqlParams()
  const rel = opened.relation(params)
  const effectiveSelection =
    selectedSource === undefined
      ? selection
      : {
          ...selection,
          dataset: selectedSource.dataset,
          from: selection.from ?? opened.window?.from,
          to: selection.to ?? opened.window?.to,
        }
  const compiled = compileFilter(effectiveSelection, {
    accepted: SEARCH_FILTER.fields,
    params,
    ...(selectedSource === undefined ? {} : { relation: rel }),
  })
  if (!compiled.ok) throw new Error("Invalid retrieval build selection")
  const idsCondition =
    selection.event_ids === undefined
      ? "TRUE"
      : `${selectedSource === undefined ? "event_id" : rel.col("event_id")} IN (${params.list(selection.event_ids)})`
  const pickedId =
    selectedSource === undefined ? "event_id" : rel.col("event_id")
  const pickedFrom = selectedSource === undefined ? "log_events" : rel.from
  const sourceCondition =
    selectedSource === undefined
      ? ""
      : ` AND ${sourceWhere(opened, rel, params)}`
  const picked = await db.query(
    `SELECT ${pickedId}${selectedSource === undefined ? "" : " AS event_id"} FROM ${pickedFrom} WHERE ${compiled.filter.where} AND ${idsCondition}${sourceCondition} ORDER BY ${pickedId} LIMIT ${params.add(selection.limit)}`,
    params.values,
    signal
  )
  const events: RetrievalImport["events"] = []
  for (const pickedRow of picked.rows) {
    const id = z.object({ event_id: exactCount }).parse(pickedRow).event_id
    const embedParams = new SqlParams()
    const embedRel = opened.relation(embedParams)
    const embedded =
      selectedSource === undefined
        ? await db.query(
            `SELECT event_id, message, ai_embed(coalesce(message, ''), $1::VARCHAR, $2::VARCHAR)::FLOAT[${meta.dimensions}] AS embedding FROM log_events WHERE event_id = $3::BIGINT ORDER BY event_id`,
            [meta.model, secret, id],
            signal
          )
        : await db.query(
            `SELECT ${embedRel.col("event_id")} AS event_id, ${embedRel.col("message")} AS message, ai_embed(coalesce(${embedRel.col("message")}, ''), ${embedParams.add(meta.model)}::VARCHAR, ${embedParams.add(secret)}::VARCHAR)::FLOAT[${meta.dimensions}] AS embedding FROM ${embedRel.from} WHERE ${embedRel.col("event_id")} = ${embedParams.add(id)}::BIGINT AND ${sourceWhere(opened, embedRel, embedParams)} ORDER BY ${embedRel.col("event_id")}`,
            embedParams.values,
            signal
          )
    const row = z
      .object({
        event_id: exactCount,
        message: z.string().nullable(),
        embedding: vector,
      })
      .parse(embedded.rows[0])
    checkVector(row.embedding, meta)
    events.push({
      event_id: row.event_id,
      message_sha256: messageDigest(row.message),
      embedding: row.embedding,
    })
  }
  const embeddedQueries: RetrievalImport["queries"] = []
  for (const query of queries) {
    const embedded = await db.query(
      `SELECT ai_embed($1::VARCHAR, $2::VARCHAR, $3::VARCHAR)::FLOAT[${meta.dimensions}] AS embedding`,
      [query, meta.model, secret],
      signal
    )
    const row = z.object({ embedding: vector }).parse(embedded.rows[0])
    checkVector(row.embedding, meta)
    embeddedQueries.push({ query, embedding: row.embedding })
  }
  return retrievalImportSchema.parse({
    ...meta,
    ...(selectedSource === undefined ? {} : { source: selectedSource }),
    events,
    queries: embeddedQueries,
  })
}

function selectionBounds(selection: { from?: string; to?: string }) {
  return {
    ...(selection.from === undefined ? {} : { from: selection.from }),
    ...(selection.to === undefined ? {} : { to: selection.to }),
  }
}
