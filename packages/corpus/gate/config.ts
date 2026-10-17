import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export type GateConfig = {
  connection: {
    host: string
    port: number
    user: string
    password: string
    database: string
  }
  /** Host paths below the workspace root; the container mounts them read-only. */
  hostRawDir: string
  hostReceiptsDir: string
  /** The same directories as seen inside the SereneDB container (compose.yaml). */
  containerRawDir: string
  containerReceiptsDir: string
}

/** Resolves the workspace root by searching upwards for pnpm-workspace.yaml, never via process.cwd(). */
function findWorkspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error("pnpm-workspace.yaml not found above the gate scripts")
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

export function loadConfig(): GateConfig {
  const port = Number(required("SERENEDB_PORT"))
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SERENEDB_PORT must be a TCP port number")
  }
  const root = findWorkspaceRoot()
  return {
    connection: {
      host: required("SERENEDB_HOST"),
      port,
      user: required("SERENEDB_USER"),
      password: required("SERENEDB_PASSWORD"),
      database: required("SERENEDB_DATABASE"),
    },
    hostRawDir: join(root, ".data", "raw"),
    hostReceiptsDir: join(root, ".data", "receipts"),
    containerRawDir: "/data/raw",
    containerReceiptsDir: "/data/receipts",
  }
}
