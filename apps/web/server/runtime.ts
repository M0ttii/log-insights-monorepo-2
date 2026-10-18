import "server-only"
import { createDatabase } from "@workspace/analytics/db"
import { loadConfig } from "@workspace/analytics/config"
import { FileReceiptStore } from "@workspace/analytics/receipts"
import { createRegistry } from "@workspace/analytics/registry"
import { FileRunStore, resolveRunsDir } from "@workspace/agent/ai-sdk"
import { loadPlaybooks } from "@workspace/agent/playbooks"
import type { ToolOutcome } from "@workspace/domain/tool"

function createRuntime() {
  const config = loadConfig()
  const db = createDatabase(config.connection)
  const receipts = new FileReceiptStore(config.receiptsDir)
  const playbooks = loadPlaybooks()
  const registry = createRegistry({
    db,
    receipts,
    roleGuidance: playbooks.guidance,
    workspaceTools: config.workspaceTools,
  })
  const runs = new FileRunStore(resolveRunsDir())
  const dispose = () => {
    void db.dispose()
  }
  process.once("SIGINT", dispose)
  process.once("SIGTERM", dispose)
  process.once("beforeExit", dispose)
  return { db, receipts, registry, playbooks, runs }
}
// A single lazy pool survives Next development module reloads.
const runtimes = globalThis as typeof globalThis & {
  logInsightsRuntime?: ReturnType<typeof createRuntime>
}
export function runtime() {
  runtimes.logInsightsRuntime ??= createRuntime()
  return runtimes.logInsightsRuntime
}
export async function runTool(
  name: string,
  input: unknown,
  signal: AbortSignal = AbortSignal.timeout(30000)
): Promise<ToolOutcome<unknown>> {
  try {
    return await runtime().registry.runTool(name, input, {
      client: "web",
      signal,
    })
  } catch {
    return {
      ok: false,
      error: {
        code: "db_unavailable",
        message: "The corpus is unavailable.",
        hint: "Check the repository .env and SereneDB, then run pnpm data:setup if no data is loaded.",
      },
    }
  }
}
