/**
 * Runs describe_corpus on the samples and prints its times as JSON, for the
 * time-zone test (separate processes with different TZ).
 * Usage: print-times.ts <receipts dir>
 */
import { createDatabase } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry } from "../../src/registry.ts"
import { loadEnv, samplesConnection } from "./helpers.ts"

loadEnv()
const [receiptsDir] = process.argv.slice(2)
if (receiptsDir === undefined) throw new Error("usage: print-times.ts <dir>")

const db = createDatabase(samplesConnection())
try {
  const registry = createRegistry({
    db,
    receipts: new FileReceiptStore(receiptsDir),
    log: () => undefined,
  })
  const outcome = await registry.runTool(
    "describe_corpus",
    {},
    {
      client: "test",
      signal: new AbortController().signal,
    }
  )
  if (!outcome.ok) throw new Error(outcome.error.message)
  const facts = outcome.result.facts
    .filter((fact) => fact.metric.endsWith("_time"))
    .map(({ path, value }) => ({ path, value }))
  process.stdout.write(
    `${JSON.stringify({ windows: outcome.result.receipt.scope.windows, facts })}\n`
  )
} finally {
  await db.dispose()
}
