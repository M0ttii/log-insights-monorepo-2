import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { Client } from "pg"

import {
  findWorkspaceRoot,
  loadConfig,
  type Connection,
} from "../../src/config.ts"

const run = promisify(execFile)

const root = findWorkspaceRoot()

/**
 * Database of the Loghub 2k samples (`pnpm data:setup --samples`, named in
 * corpus/src/sources.ts; analytics may not import the corpus package).
 */
const SAMPLES_DATABASE = "log_insights_samples"

/**
 * Database of the base 2k samples plus the five Loghub extensions
 * (`pnpm data:setup --samples --with all`, SAMPLES_EXTENDED_DATABASE in
 * corpus/src/sources.ts; U26). Used by the extension integration tests.
 */
const SAMPLES_EXTENDED_DATABASE = "log_insights_samples_ext"

/** Loads the root .env like the Node scripts do (--env-file-if-exists). */
export function loadEnv(): void {
  const file = join(root, ".env")
  if (existsSync(file)) process.loadEnvFile(file)
}

export function samplesConnection(): Connection {
  return { ...loadConfig().connection, database: SAMPLES_DATABASE }
}

export function extendedSamplesConnection(): Connection {
  return { ...loadConfig().connection, database: SAMPLES_EXTENDED_DATABASE }
}

export async function temporaryDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** Runs a script of this directory with tsx in a separate process and time zone. */
export async function runScript(
  script: string,
  args: string[],
  timeZone: string
): Promise<string> {
  const { stdout } = await run(
    process.execPath,
    ["--import", "tsx", join(import.meta.dirname, script), ...args],
    {
      cwd: join(root, "packages", "analytics"),
      env: { ...process.env, TZ: timeZone },
    }
  )
  return stdout
}

/**
 * Creates a fixture database next to the samples if needed and runs its
 * statements, one per round trip: a dictionary created in the same simple
 * query is invisible to CREATE INDEX (gate G1). Idempotent when the
 * statements are.
 */
export async function rebuildDatabase(
  connection: Connection,
  statements: readonly string[]
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(connection.database))
    throw new RangeError(`invalid database name: ${connection.database}`)
  const admin = new Client(samplesConnection())
  await admin.connect()
  try {
    const found = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [connection.database]
    )
    if (found.rowCount === 0)
      await admin.query(`CREATE DATABASE ${connection.database}`)
  } finally {
    await admin.end()
  }

  const client = new Client(connection)
  await client.connect()
  try {
    await client.query("SET TimeZone = 'UTC'")
    for (const statement of statements) await client.query(statement)
  } finally {
    await client.end()
  }
}
