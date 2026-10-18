import { execFile } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { promisify } from "node:util"

import type { Client } from "pg"

import {
  connectionFromEnv,
  findWorkspaceRoot,
  hostRawDir,
  type Connection,
} from "./config.ts"
import { openClient } from "./db.ts"
import { ensureSourceFiles, type RawFile } from "./download.ts"
import {
  expectedServerVersion,
  isDigestPinned,
  LOCAL_IMAGES,
  validateImage,
  type ImageIdentity,
} from "./image.ts"
import { dataVersion, sqlDigest, type ManifestInput } from "./manifest.ts"
import {
  cleanupPlaceholders,
  loadSteps,
  readSql,
  SQL_FILES,
  type LoadFacts,
  type SqlFile,
  type Timings,
} from "./plan.ts"
import { ensureFixtures, pinRemoteFiles, type ExternalPin } from "./remote.ts"
import type { ExternalLoad, Source } from "./sources.ts"
import { fillPlaceholders, splitSqlScript } from "./sql-script.ts"
import { VERSIONS } from "./versions.ts"

const execFileAsync = promisify(execFile)

type Log = (message: string) => void

export type LoadCheck = {
  check_name: string
  expected: string
  observed: string
  ok: boolean
}

export type LoadReportRow = {
  dataset: string
  source_file: string
  lines_read: string
  events_loaded: string
  rejected: string
  /** JSON object of reason → count (the driver may return it as text). */
  reason_counts: unknown
  duration_s: number
}

type ExternalSummary = {
  dataset: string
  kind: ExternalLoad["kind"]
  files: number
  footer_rows: string
  bytes: string
  reference: Record<string, unknown>
  index_ms: number
  index_disk_kib: number | null
}

export type LoadResult = {
  database: string
  dataVersion: string
  files: RawFile[]
  checks: LoadCheck[]
  report: LoadReportRow[]
  stats: Array<Record<string, unknown>>
  external: ExternalSummary[]
  timingsMs: Timings & { index: number; total: number }
}

export class LoadCheckFailed extends Error {
  constructor(readonly checks: LoadCheck[]) {
    super(
      `${checks.filter((check) => !check.ok).length} load check(s) failed; ` +
        "staging tables were kept for inspection and no manifest was written"
    )
  }
}

const READY_TIMEOUT_MS = 90_000

/** Buffer manager limit during a load (see runLoad). */
const LOAD_MEMORY_LIMIT = "3GB"

async function docker(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", args, { cwd: root })
    return stdout.trim()
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : ""
    throw new Error(`docker ${args.join(" ")} failed: ${detail}`, {
      cause: error,
    })
  }
}

/** Waits until SereneDB answers `SELECT 1` with our credentials. */
async function waitForSereneDb(
  connection: Connection,
  log: Log
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastError = "no attempt"
  let announced = false
  while (Date.now() < deadline) {
    try {
      const client = await openClient(connection, {
        connectionTimeoutMillis: 3_000,
      })
      try {
        await client.query("SELECT 1")
        return
      } finally {
        await client.end()
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (!announced) {
        log("  waiting for SereneDB …")
        announced = true
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  throw new Error(
    `SereneDB did not answer SELECT 1 on ${connection.host}:${connection.port} ` +
      `within ${READY_TIMEOUT_MS / 1000} s (last error: ${lastError}). ` +
      "Check `docker compose ps` and SERENEDB_PASSWORD in .env."
  )
}

/** Creates the target database of a source if it does not exist yet. */
async function ensureDatabase(
  connection: Connection,
  name: string
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsupported database name ${name}`)
  }
  const client = await openClient(connection)
  try {
    const found = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [name]
    )
    if (found.rowCount === 0) await client.query(`CREATE DATABASE ${name}`)
  } finally {
    await client.end()
  }
}

/**
 * Makes the configured image available without ever resolving a mutable tag
 * against a registry: a digest-pinned reference is pulled if missing, a local
 * tag must already be present (compose.yaml sets `pull_policy: never`).
 */
async function ensureImage(root: string): Promise<void> {
  const reference = await docker(root, [
    "compose",
    "config",
    "--images",
    "serenedb",
  ])
  if (reference === "" || reference.includes("\n")) {
    throw new Error(`Unexpected image list from docker compose: ${reference}`)
  }
  const present = await docker(root, ["image", "inspect", reference]).then(
    () => true,
    () => false
  )
  if (present) return
  if (!isDigestPinned(reference)) {
    const local = LOCAL_IMAGES.find((image) => image.reference === reference)
    throw new Error(
      `SereneDB image ${reference} is not present and is never pulled (not ` +
        `pinned by digest)${local === undefined ? "" : `; restore it with ${local.restore}`}`
    )
  }
  await docker(root, ["pull", reference])
}

type ContainerFacts = {
  /** `.Config.Image`: the reference Compose started. */
  reference: string
  /** `.Image`: the image ID (config digest). */
  imageId: string
  /** Host bindings of container port 7890 as `ip:port`. */
  published: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Reads the fields the loader needs from `docker inspect <id>` output. */
function parseInspect(json: string): ContainerFacts {
  const parsed: unknown = JSON.parse(json)
  const container: unknown = Array.isArray(parsed) ? parsed[0] : undefined
  if (!isRecord(container) || !isRecord(container["Config"])) {
    throw new Error("Unexpected output of docker inspect")
  }
  const reference = container["Config"]["Image"]
  const imageId = container["Image"]
  const network = container["NetworkSettings"]
  const ports = isRecord(network) ? network["Ports"] : undefined
  const bindings = isRecord(ports) ? ports["7890/tcp"] : undefined
  if (typeof reference !== "string" || typeof imageId !== "string") {
    throw new Error("docker inspect reports no image for the container")
  }
  const published = (Array.isArray(bindings) ? bindings : []).map(
    (binding: unknown) =>
      isRecord(binding)
        ? `${String(binding["HostIp"])}:${String(binding["HostPort"])}`
        : "?"
  )
  return { reference, imageId, published }
}

/**
 * Image of the running SereneDB container of this Compose project, after
 * checking that it is the server the loader connects to: its port 7890 must
 * be published on 127.0.0.1 at SERENEDB_PORT. Otherwise a second checkout's
 * container could be inspected while another one is loaded.
 */
async function serenedbImage(
  root: string,
  connection: Connection
): Promise<ImageIdentity> {
  const id = await docker(root, ["compose", "ps", "-q", "serenedb"])
  if (id === "") throw new Error("The serenedb Compose service is not running")
  const { reference, imageId, published } = parseInspect(
    await docker(root, ["inspect", id])
  )
  const expected = `127.0.0.1:${String(connection.port)}`
  if (
    connection.host !== "127.0.0.1" ||
    published.length === 0 ||
    !published.every((binding) => binding === expected)
  ) {
    throw new Error(
      `SereneDB container ${id.slice(0, 12)} publishes 7890 on ` +
        `${published.join(", ") || "no host port"}, but the loader connects to ` +
        `${connection.host}:${String(connection.port)}; check SERENEDB_PORT and ` +
        "COMPOSE_PROJECT_NAME in .env"
    )
  }
  return validateImage({ reference, imageId })
}

/** `SELECT version()`, checked against the expectation of a listed local build. */
async function serverVersion(
  connection: Connection,
  image: ImageIdentity
): Promise<string> {
  const client = await openClient(connection)
  try {
    const { rows } = await client.query<{ version: string }>(
      "SELECT version() AS version"
    )
    const version = rows[0]?.version
    if (typeof version !== "string") throw new Error("No server version")
    const expected = expectedServerVersion(image.reference)
    if (expected !== null && version !== expected) {
      throw new Error(
        `SereneDB image ${image.reference} reports ${version}, expected ${expected}`
      )
    }
    return version
  } finally {
    await client.end()
  }
}

async function runScript(
  client: Client,
  file: SqlFile,
  sql: string,
  placeholders: Record<string, string>
): Promise<void> {
  const statements = splitSqlScript(fillPlaceholders(sql, placeholders))
  for (const [index, statement] of statements.entries()) {
    try {
      await client.query(statement)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `${file}, statement ${index + 1} of ${statements.length}: ${message}`,
        { cause: error }
      )
    }
  }
}

/** Directory of this package, for the committed fixtures (LOG-35). */
const CORPUS_DIR = new URL("..", import.meta.url).pathname

/**
 * Disk size of the otel reference index (LOG-35, design D4): view-backed
 * indexes report 0 in pg_indexes_size, so the engine_search directory of
 * the view is measured with du inside the container. null when that fails.
 */
async function indexDiskKib(
  root: string,
  client: Client
): Promise<number | null> {
  try {
    const { rows } = await client.query<{
      db: string
      ns: string
      view: string
    }>(
      `SELECT (SELECT oid FROM pg_database WHERE datname = current_database())::VARCHAR AS db,
         c.relnamespace::VARCHAR AS ns, c.oid::VARCHAR AS view
       FROM pg_class c WHERE c.relname = 'otel_ref'`
    )
    const row = rows[0]
    if (
      row === undefined ||
      ![row.db, row.ns, row.view].every((v) => /^\d+$/.test(v))
    )
      return null
    const out = await docker(root, [
      "compose",
      "exec",
      "-T",
      "serenedb",
      "du",
      "-sk",
      `/var/lib/serenedb/engine_search/${row.db}/${row.ns}/${row.view}`,
    ])
    const kib = Number(out.split(/\s/)[0])
    return Number.isSafeInteger(kib) ? kib : null
  } catch {
    return null
  }
}

async function timed(run: () => Promise<void>): Promise<number> {
  const start = performance.now()
  await run()
  return performance.now() - start
}

/**
 * Loads a source into SereneDB (technical.md § 7): starts the Compose
 * service of this checkout (project, port and image from .env), verifies the
 * image identity and server version, makes the raw files present and
 * verified, runs sql/ in order,
 * checks the result, writes load_manifest and returns the load balance.
 */
export async function runLoad(source: Source, log: Log): Promise<LoadResult> {
  const totalStart = performance.now()
  const root = findWorkspaceRoot()
  const baseConnection = connectionFromEnv()
  const connection: Connection = {
    ...baseConnection,
    database: source.database ?? baseConnection.database,
  }

  log("SereneDB")
  // Create the bind-mount sources first: if Docker creates them, they belong
  // to root on Linux and the download cannot write into them.
  const rawDir = hostRawDir(root)
  await mkdir(rawDir, { recursive: true })
  await mkdir(join(root, ".data", "receipts"), { recursive: true })
  await ensureImage(root)
  await docker(root, ["compose", "up", "-d", "--pull", "never", "serenedb"])
  await waitForSereneDb(baseConnection, log)
  if (source.database !== null)
    await ensureDatabase(baseConnection, source.database)
  const image = await serenedbImage(root, baseConnection)
  const server = await serverVersion(baseConnection, image)
  log(
    `  ${image.reference} (image ID ${image.imageId}), ${server}, database ${connection.database}`
  )

  log(`Raw files (${source.description})`)
  const files = await ensureSourceFiles(source, rawDir, log)
  for (const file of files) {
    log(
      `  ${file.fetched ? "fetched" : "present"}  ${file.path}  ${file.bytes} bytes  sha256 ${file.sha256}`
    )
  }
  // Remote datasets (LOG-35): pins by HEAD, never a download; or the
  // committed fixtures with --samples.
  const pins = new Map<string, ExternalPin[]>()
  for (const load of source.external) {
    log(`Remote files (${load.dataset}, ${load.kind})`)
    pins.set(
      load.dataset,
      load.kind === "remote"
        ? await pinRemoteFiles(load, log)
        : await ensureFixtures(load, rawDir, CORPUS_DIR, log)
    )
  }
  const externalSources = source.external.map((load) => ({
    dataset: load.dataset,
    kind: load.kind,
    mapping_version: VERSIONS.otelMapping,
    reference: load.reference,
    files: pins.get(load.dataset) ?? [],
  }))

  const sources = await Promise.all(
    SQL_FILES.map(async (name) => ({ name, content: await readSql(name) }))
  )
  const sqlByName = new Map(sources.map(({ name, content }) => [name, content]))
  const sql = (name: SqlFile) => {
    const content = sqlByName.get(name)
    if (content === undefined) throw new Error(`Missing SQL file ${name}`)
    return content
  }
  const labelPaths = new Set(
    source.datasets.flatMap(({ labels }) => (labels === null ? [] : [labels]))
  )
  const loadedPaths = new Set([
    ...source.datasets.flatMap(({ logs }) => logs),
    ...labelPaths,
  ])
  const manifest: ManifestInput = {
    source: source.id,
    datasets: source.datasets.map(({ dataset }) => dataset),
    files: files
      .filter((file) => loadedPaths.has(file.path))
      .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    image: image.reference,
    imageId: image.imageId,
    serverVersion: server,
    versions: VERSIONS,
    sqlDigest: sqlDigest(sources),
    ...(externalSources.length === 0 ? {} : { externalSources }),
  }
  const version = dataVersion(manifest)

  const client = await openClient(connection)
  try {
    log("Load")
    // Bounds SereneDB's buffer manager for the load (U26): with HDFS the
    // shared steps build log_events from about 17 million lines, and the
    // default limit (80 % of the VM memory) let the server process run out
    // of memory when another instance shares the Docker VM (observed on an
    // 8 GB VM). Larger intermediates spill to disk. memory_limit is a global
    // setting, so the default is restored afterwards.
    await client.query(`SET memory_limit = '${LOAD_MEMORY_LIMIT}'`)
    const timings: Timings = { shared: 0 }
    let indexMs = 0
    const otelPins = pins.get("otel")
    const facts: LoadFacts = otelPins === undefined ? {} : { otelPins }
    let builtAt = ""
    for (const step of loadSteps(source)) {
      if (step.file === "61_otel_reference.sql")
        builtAt = new Date().toISOString()
      const ms = await timed(() =>
        runScript(
          client,
          step.file,
          sql(step.file),
          step.placeholders(timings, facts)
        )
      )
      timings[step.timing] = (timings[step.timing] ?? 0) + ms
      if (step.file === "50_index.sql") indexMs = ms
      if (step.file === "60_otel_sources.sql")
        facts.otelRanges = (
          await client.query<{
            file_index: number
            from: string
            to: string | null
          }>(
            `SELECT file_index, strftime(assigned_from, '%Y-%m-%dT%H:%M:%S.%nZ') AS "from",
               strftime(assigned_to, '%Y-%m-%dT%H:%M:%S.%nZ') AS "to"
             FROM otel_sources ORDER BY file_index`
          )
        ).rows
      if (step.file === "61_otel_reference.sql")
        facts.otelIndex = { builtAt, ms }
      log(`  ${step.file.padEnd(20)} ${(ms / 1000).toFixed(1).padStart(6)} s`)
    }

    const checks = (
      await client.query<LoadCheck>(
        "SELECT check_name, expected, observed, ok FROM load_checks"
      )
    ).rows
    const report = (
      await client.query<LoadReportRow>(
        `SELECT dataset, source_file, lines_read, events_loaded, rejected,
           reason_counts, duration_s FROM load_report ORDER BY dataset, source_file`
      )
    ).rows

    // Independent of SereneDB: lines counted by Node while hashing the file.
    for (const file of files.filter((f) => loadedPaths.has(f.path))) {
      if (labelPaths.has(file.path)) continue
      const row = report.find((r) => r.source_file === basename(file.path))
      const lines = row === undefined ? "missing" : row.lines_read
      checks.push({
        check_name: `lines_read = physical lines of ${file.path} (counted by Node)`,
        expected: String(file.lines),
        observed: lines,
        ok: lines === String(file.lines),
      })
    }
    if (checks.some((check) => !check.ok)) throw new LoadCheckFailed(checks)

    // Remote summary and index facts for the manifest (not part of
    // data_version: the build time differs on every run).
    const external: ExternalSummary[] = []
    for (const load of source.external) {
      const { rows } = await client.query<{
        files: string
        footer_rows: string
        bytes: string
      }>(
        "SELECT count(*)::VARCHAR AS files, sum(footer_rows)::VARCHAR AS footer_rows, sum(size)::VARCHAR AS bytes FROM otel_sources"
      )
      const reference = (
        await client.query<Record<string, unknown>>(
          `SELECT index_name, source_glob, strftime(window_from, '%Y-%m-%dT%H:%M:%S.%fZ') AS window_from,
             strftime(window_to, '%Y-%m-%dT%H:%M:%S.%fZ') AS window_to,
             strftime(built_at, '%Y-%m-%dT%H:%M:%S.%fZ') AS built_at, build_ms,
             events::VARCHAR AS events, duplicates_removed::VARCHAR AS duplicates_removed, mapping_version
           FROM otel_reference`
        )
      ).rows[0]
      const totals = rows[0]
      if (reference === undefined || totals === undefined)
        throw new Error("otel tables missing after the checks")
      external.push({
        dataset: load.dataset,
        kind: load.kind,
        files: Number(totals.files),
        footer_rows: totals.footer_rows,
        bytes: totals.bytes,
        reference,
        index_ms: facts.otelIndex?.ms ?? 0,
        index_disk_kib: await indexDiskKib(root, client),
      })
    }
    const externalManifest =
      externalSources.length === 0
        ? null
        : externalSources.map((entry) => {
            const summary = external.find(
              (row) => row.dataset === entry.dataset
            )
            return {
              ...entry,
              index: {
                ...summary?.reference,
                build_ms: summary?.index_ms ?? null,
                disk_kib: summary?.index_disk_kib ?? null,
              },
            }
          })

    const [manifestStatement, ...extra] = splitSqlScript(sql("95_manifest.sql"))
    if (manifestStatement === undefined || extra.length > 0) {
      throw new Error("95_manifest.sql must hold exactly one statement")
    }
    await client.query(manifestStatement, [
      version,
      new Date().toISOString(),
      source.id,
      JSON.stringify(manifest.files),
      manifest.image,
      manifest.imageId,
      manifest.serverVersion,
      VERSIONS.loader,
      VERSIONS.parser,
      VERSIONS.patternRules,
      VERSIONS.ownership,
      VERSIONS.rules,
      manifest.sqlDigest,
      JSON.stringify(manifest.datasets),
      externalManifest === null ? null : JSON.stringify(externalManifest),
    ])
    await runScript(
      client,
      "99_cleanup.sql",
      sql("99_cleanup.sql"),
      cleanupPlaceholders(source)
    )

    const stats = (
      await client.query<Record<string, unknown>>(
        `SELECT dataset, lines_read, events, rejected, first_ts, last_ts,
           patterns, single_event_patterns, api_accesses,
           api_accesses_without_request_id, requests
         FROM corpus_stats ORDER BY dataset`
      )
    ).rows

    return {
      database: connection.database,
      dataVersion: version,
      files,
      checks,
      report,
      stats,
      external,
      timingsMs: {
        ...timings,
        index: indexMs,
        total: performance.now() - totalStart,
      },
    }
  } finally {
    await client.query("RESET memory_limit").catch(() => undefined)
    await client.end()
  }
}
