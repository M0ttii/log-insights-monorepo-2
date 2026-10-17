import { join } from "node:path"

import {
  CONTAINER_RAW_DIR,
  connectionFromEnv,
  findWorkspaceRoot,
  hostRawDir,
  type Connection,
} from "../src/config.ts"

export type GateConfig = {
  connection: Connection
  /** Host paths below the workspace root; the container mounts them read-only. */
  hostRawDir: string
  hostReceiptsDir: string
  /** The same directories as seen inside the SereneDB container (compose.yaml). */
  containerRawDir: string
  containerReceiptsDir: string
}

export function loadConfig(): GateConfig {
  const root = findWorkspaceRoot()
  return {
    connection: connectionFromEnv(),
    hostRawDir: hostRawDir(root),
    hostReceiptsDir: join(root, ".data", "receipts"),
    containerRawDir: CONTAINER_RAW_DIR,
    containerReceiptsDir: "/data/receipts",
  }
}
