/**
 * Runs event_trend on the samples and prints its buckets and digest as
 * JSON, for the time-zone test (separate processes with different TZ).
 * Usage: print-trend.ts <receipts dir> <bucket>
 */
import { createDatabase } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry } from "../../src/registry.ts"
import { loadEnv, samplesConnection } from "./helpers.ts"

loadEnv()
const [receiptsDir, bucket] = process.argv.slice(2)
if (receiptsDir === undefined || bucket === undefined)
  throw new Error("usage: print-trend.ts <dir> <bucket>")

const db = createDatabase(samplesConnection())
try {
  const registry = createRegistry({
    db,
    receipts: new FileReceiptStore(receiptsDir),
    log: () => undefined,
  })
  const outcome = await registry.runTool(
    "event_trend",
    {
      dataset: "bgl",
      bucket,
      from: "2005-06-01T00:00:00-07:00",
      to: "2005-06-15T00:00:00-07:00",
      split_by: "level",
    },
    { client: "test", signal: new AbortController().signal }
  )
  if (!outcome.ok) throw new Error(outcome.error.message)
  process.stdout.write(
    `${JSON.stringify({ data: outcome.result.data, digest: outcome.result.receipt.result_digest })}\n`
  )
} finally {
  await db.dispose()
}
