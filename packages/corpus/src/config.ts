import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export type Connection = {
  host: string
  port: number
  user: string
  password: string
  database: string
}

/**
 * Resolves the workspace root by searching upwards for pnpm-workspace.yaml.
 * Never via process.cwd(): pnpm runs scripts in the package directory and
 * other clients may start processes from anywhere (technical.md § 4).
 */
export function findWorkspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error("pnpm-workspace.yaml not found above packages/corpus")
    }
    dir = parent
  }
  return dir
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set; copy .env.example to .env`)
  }
  return value
}

/** SereneDB connection from SERENEDB_* (.env, see .env.example). */
export function connectionFromEnv(): Connection {
  const port = Number(required("SERENEDB_PORT"))
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SERENEDB_PORT must be a TCP port number")
  }
  return {
    host: required("SERENEDB_HOST"),
    port,
    user: required("SERENEDB_USER"),
    password: required("SERENEDB_PASSWORD"),
    database: required("SERENEDB_DATABASE"),
  }
}

/** Host directory of the raw files and its mount point inside the SereneDB container (compose.yaml). */
export const CONTAINER_RAW_DIR = "/data/raw"

export function hostRawDir(root: string = findWorkspaceRoot()): string {
  return join(root, ".data", "raw")
}
