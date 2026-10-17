import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

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

/** Loads the root .env like the Node scripts do (--env-file-if-exists). */
export function loadEnv(): void {
  const file = join(root, ".env")
  if (existsSync(file)) process.loadEnvFile(file)
}

export function samplesConnection(): Connection {
  return { ...loadConfig().connection, database: SAMPLES_DATABASE }
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
