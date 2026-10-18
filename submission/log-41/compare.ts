import { writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { createDatabase } from "../../packages/analytics/src/db.ts"
import { loadConfig } from "../../packages/analytics/src/config.ts"
import { FileReceiptStore } from "../../packages/analytics/src/receipts.ts"
import { createRegistry } from "../../packages/analytics/src/registry.ts"
import questions from "./questions.json" with { type: "json" }

const directory = dirname(fileURLToPath(import.meta.url))
const config = loadConfig()
const snapshot = process.argv[2]
const db = createDatabase(config.connection)
const registry = createRegistry({
  db,
  receipts: new FileReceiptStore(config.receiptsDir),
  log: () => undefined,
})
const rows: Array<Record<string, unknown>> = []
try {
  for (const question of questions.questions) {
    for (const match of questions.modes) {
      const started = performance.now()
      const outcome = await registry.runTool(
        "search_logs",
        {
          query: question.query,
          dataset: questions.dataset,
          match,
          limit: questions.limit,
          ...(match === "terms" || snapshot === undefined
            ? {}
            : { retrieval_snapshot: snapshot }),
        },
        { client: "test", signal: new AbortController().signal }
      )
      rows.push({
        question_id: question.id,
        query: question.query,
        mode: match,
        elapsed_ms: Math.round((performance.now() - started) * 100) / 100,
        model_requests_this_run:
          match === "terms" || snapshot === undefined ? 0 : null,
        model_cost_this_run:
          match === "terms" || snapshot === undefined ? 0 : null,
        embedding_snapshot_build_cost: null,
        ...(outcome.ok
          ? { receipt: outcome.result.receipt, result: outcome.result.data }
          : { error: outcome.error }),
      })
    }
  }
} finally {
  await db.dispose()
}
await writeFile(
  join(directory, "comparison.json"),
  `${JSON.stringify(
    {
      question_set_version: questions.version,
      generated_at: new Date().toISOString(),
      execution:
        "Real local SereneDB. Lexical and missing-snapshot failures perform no model requests; provider usage/cost for an explicitly supplied snapshot is unavailable to this runner and is recorded as null.",
      quality_conclusion:
        "No semantic or hybrid quality advantage established. Unavailable snapshots/providers are explicit failed cases, not lexical fallbacks.",
      rows,
    },
    null,
    2
  )}\n`
)
