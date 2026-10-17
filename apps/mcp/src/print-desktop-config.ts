import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { join } from "node:path"

import { findWorkspaceRoot } from "@workspace/analytics/config"

/** Desktop does not inherit the shell PATH; use Node and tsx by absolute path. */
export function desktopConfig() {
  const root = findWorkspaceRoot()
  const require = createRequire(import.meta.url)
  return {
    mcpServers: {
      "log-insights": {
        command: process.execPath,
        args: [
          `--env-file-if-exists=${join(root, ".env")}`,
          require.resolve("tsx/cli"),
          join(root, "apps/mcp/src/server.ts"),
        ],
      },
    },
  }
}

const entrypoint = process.argv[1]
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  process.stdout.write(`${JSON.stringify(desktopConfig(), null, 2)}\n`)
}
