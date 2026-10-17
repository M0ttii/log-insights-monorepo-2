import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

import type { Client } from "pg"

import { connectionFromEnv, findWorkspaceRoot } from "../../src/config.ts"
import { openClient } from "../../src/db.ts"

const run = promisify(execFile)

export const root = findWorkspaceRoot()

/** Loads the root .env like `pnpm data:setup` does (--env-file-if-exists). */
export function loadEnv(): void {
  const file = join(root, ".env")
  if (existsSync(file)) process.loadEnvFile(file)
}

export async function connectTo(database: string): Promise<Client> {
  return openClient({ ...connectionFromEnv(), database })
}

/** Rows of a query as plain objects; integration tests compare them literally. */
export async function rows(
  client: Client,
  sql: string,
  values: unknown[] = []
): Promise<Array<Record<string, unknown>>> {
  return (await client.query<Record<string, unknown>>(sql, values)).rows
}

/** Runs `pnpm data:setup <args>` as a separate process with the given time zone. */
export async function runSetupCli(
  args: string[],
  timeZone: string
): Promise<string> {
  const { stdout } = await run("pnpm", ["--silent", "data:setup", ...args], {
    cwd: root,
    env: { ...process.env, TZ: timeZone },
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

/** Runs a script of this directory with tsx in a separate process. */
export async function runScript(
  script: string,
  args: string[],
  timeZone: string
): Promise<string> {
  const { stdout } = await run(
    process.execPath,
    ["--import", "tsx", join(import.meta.dirname, script), ...args],
    {
      cwd: join(root, "packages", "corpus"),
      env: { ...process.env, TZ: timeZone },
    }
  )
  return stdout
}

export function dataVersionOf(output: string): string {
  const match = /data_version (dv_[0-9a-f]{16})/.exec(output)
  if (match?.[1] === undefined)
    throw new Error(`No data_version in:\n${output}`)
  return match[1]
}
