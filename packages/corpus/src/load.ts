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
import { dataVersion, sqlDigest, type ManifestInput } from "./manifest.ts"
import {
  loadSteps,
  readSql,
  SQL_FILES,
  type SqlFile,
  type Timings,
} from "./plan.ts"
import type { Source } from "./sources.ts"
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

export type LoadResult = {
  database: string
  dataVersion: string
  files: RawFile[]
  checks: LoadCheck[]
  report: LoadReportRow[]
  stats: Array<Record<string, unknown>>
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

/** Image reference (tag and digest) of the running SereneDB container. */
async function serenedbImage(root: string): Promise<string> {
  const id = await docker(root, ["compose", "ps", "-q", "serenedb"])
  if (id === "") throw new Error("The serenedb Compose service is not running")
  const image = await docker(root, [
    "inspect",
    "--format",
    "{{.Config.Image}}",
    id,
  ])
  if (!image.includes("@sha256:")) {
    throw new Error(
      `SereneDB image ${image} is not pinned by digest (compose.yaml)`
    )
  }
  return image
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

async function timed(run: () => Promise<void>): Promise<number> {
  const start = performance.now()
  await run()
  return performance.now() - start
}

/**
 * Loads a source into SereneDB (technical.md § 7): starts the Compose
 * service, makes the raw files present and verified, runs sql/ in order,
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
  await docker(root, ["compose", "up", "-d", "serenedb"])
  await waitForSereneDb(baseConnection, log)
  if (source.database !== null)
    await ensureDatabase(baseConnection, source.database)
  const image = await serenedbImage(root)
  log(`  ${image}, database ${connection.database}`)

  log(`Raw files (${source.description})`)
  const files = await ensureSourceFiles(source, rawDir, log)
  for (const file of files) {
    log(
      `  ${file.fetched ? "fetched" : "present"}  ${file.path}  ${file.bytes} bytes  sha256 ${file.sha256}`
    )
  }

  const sources = await Promise.all(
    SQL_FILES.map(async (name) => ({ name, content: await readSql(name) }))
  )
  const sqlByName = new Map(sources.map(({ name, content }) => [name, content]))
  const sql = (name: SqlFile) => {
    const content = sqlByName.get(name)
    if (content === undefined) throw new Error(`Missing SQL file ${name}`)
    return content
  }
  const loadedPaths = new Set([
    source.bglLog,
    ...source.openstackLogs,
    ...(source.openstackLabels === null ? [] : [source.openstackLabels]),
  ])
  const manifest: ManifestInput = {
    source: source.id,
    files: files
      .filter((file) => loadedPaths.has(file.path))
      .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    image,
    versions: VERSIONS,
    sqlDigest: sqlDigest(sources),
  }
  const version = dataVersion(manifest)

  const client = await openClient(connection)
  try {
    log("Load")
    const timings: Timings = { bgl: 0, openstack: 0, shared: 0 }
    let indexMs = 0
    for (const step of loadSteps(source)) {
      const ms = await timed(() =>
        runScript(client, step.file, sql(step.file), step.placeholders(timings))
      )
      timings[step.timing] += ms
      if (step.file === "50_index.sql") indexMs = ms
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
      if (file.path === source.openstackLabels) continue
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

    const [manifestStatement, ...extra] = splitSqlScript(sql("95_manifest.sql"))
    if (manifestStatement === undefined || extra.length > 0) {
      throw new Error("95_manifest.sql must hold exactly one statement")
    }
    await client.query(manifestStatement, [
      version,
      new Date().toISOString(),
      source.id,
      JSON.stringify(manifest.files),
      image,
      VERSIONS.loader,
      VERSIONS.parser,
      VERSIONS.patternRules,
      VERSIONS.ownership,
      VERSIONS.rules,
      manifest.sqlDigest,
    ])
    await runScript(client, "99_cleanup.sql", sql("99_cleanup.sql"), {})

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
      timingsMs: {
        ...timings,
        index: indexMs,
        total: performance.now() - totalStart,
      },
    }
  } finally {
    await client.end()
  }
}
