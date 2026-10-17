/**
 * Runs describe_corpus on the samples in this process and prints the
 * receipt ID and facts as JSON, so check_claims can be tested against a
 * receipt another process wrote (U05: atomic link into place).
 * Usage: print-facts.ts <receipts dir>
 */
import { createDatabase } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry } from "../../src/registry.ts"
import { loadEnv, samplesConnection } from "./helpers.ts"

loadEnv()
const [receiptsDir] = process.argv.slice(2)
if (receiptsDir === undefined) throw new Error("usage: print-facts.ts <dir>")

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
    { client: "test", signal: new AbortController().signal }
  )
  if (!outcome.ok) throw new Error(outcome.error.message)
  process.stdout.write(
    `${JSON.stringify({
      receipt_id: outcome.result.receipt.receipt_id,
      facts: outcome.result.facts,
    })}\n`
  )
} finally {
  await db.dispose()
}
