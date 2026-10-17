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

/**
 * Closes the client a suite's beforeAll opened. If beforeAll failed before
 * connecting, the variable is still unassigned at run time: there is nothing
 * to close, and vitest reports the setup error instead of a TypeError from
 * the teardown. An error while closing an open client still fails the run.
 */
export async function closeIfOpen(client: Client | undefined): Promise<void> {
  if (client !== undefined) await client.end()
}

/** Rows of a query as plain objects; integration tests compare them literally. */
export async function rows(
  client: Client,
  sql: string,
  values: unknown[] = []
): Promise<Array<Record<string, unknown>>> {
  return (await client.query<Record<string, unknown>>(sql, values)).rows
}

const docker = async (args: string[]) =>
  (await run("docker", args, { cwd: root })).stdout.trim()

/**
 * Reference and image ID of this checkout's running serenedb container, read
 * with docker directly rather than through the loader.
 */
export async function composeContainerImage(): Promise<{
  reference: string
  imageId: string
}> {
  const id = await docker(["compose", "ps", "-q", "serenedb"])
  const [reference = "", imageId = ""] = (
    await docker(["inspect", "--format", "{{.Config.Image}} {{.Image}}", id])
  ).split(" ")
  return { reference, imageId }
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
