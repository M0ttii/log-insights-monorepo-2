/**
 * Runs get_log_context mode event on the samples and prints its data as
 * JSON, for the time-zone test (separate processes with different TZ).
 * Usage: print-context.ts <receipts dir> <event_id>
 */
import { createDatabase } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry } from "../../src/registry.ts"
import { loadEnv, samplesConnection } from "./helpers.ts"

loadEnv()
const [receiptsDir, eventId] = process.argv.slice(2)
if (receiptsDir === undefined || eventId === undefined)
  throw new Error("usage: print-context.ts <dir> <event_id>")

const db = createDatabase(samplesConnection())
try {
  const registry = createRegistry({
    db,
    receipts: new FileReceiptStore(receiptsDir),
    log: () => undefined,
  })
  const outcome = await registry.runTool(
    "get_log_context",
    { mode: "event", event_id: eventId, scope: "dataset" },
    { client: "test", signal: new AbortController().signal }
  )
  if (!outcome.ok) throw new Error(outcome.error.message)
  process.stdout.write(
    `${JSON.stringify({ data: outcome.result.data, digest: outcome.result.receipt.result_digest })}\n`
  )
} finally {
  await db.dispose()
}
