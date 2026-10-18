import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadConfig } from "../../packages/analytics/src/config.ts"
import { createDatabase } from "../../packages/analytics/src/db.ts"
import { FileReceiptStore } from "../../packages/analytics/src/receipts.ts"
import { createRegistry } from "../../packages/analytics/src/registry.ts"
import { recurringPatternsOutputSchema } from "../../packages/domain/src/tools/recurring-patterns.ts"
import { checkClaimsOutputSchema } from "../../packages/domain/src/tools/check-claims.ts"

const directory = dirname(fileURLToPath(import.meta.url))
const config = loadConfig()
const db = createDatabase(config.connection)
const receipts = new FileReceiptStore(config.receiptsDir)
const registry = createRegistry({ db, receipts, log: () => undefined })
const window = {
  dataset: "bgl",
  from: "2005-06-10T00:00:00Z",
  to: "2005-06-11T00:00:00Z",
}
const call = () => ({
  client: "test" as const,
  signal: new AbortController().signal,
})
const records: Array<Record<string, unknown>> = []
await mkdir(join(directory, "receipts"), { recursive: true })
async function persist(id: string) {
  const receipt = await receipts.get(id)
  if (receipt === null) throw new Error(`Missing receipt ${id}`)
  await writeFile(
    join(directory, "receipts", `${id}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`
  )
}
try {
  const initial = await registry.runTool(
    "recurring_patterns",
    { ...window, limit: 3 },
    call()
  )
  if (!initial.ok) throw new Error(JSON.stringify(initial.error))
  const patterns = recurringPatternsOutputSchema.parse(
    initial.result.data
  ).patterns
  const a = patterns[0]?.pattern_id
  const b = patterns[1]?.pattern_id
  if (a === undefined || b === undefined)
    throw new Error(
      "Two observed patterns are required for the discriminating temporal checks"
    )
  const cases = [
    {
      role: "engineer",
      mode: "entities",
      tool: "count_events",
      input: {
        dataset: "openstack",
        group_by: ["component"],
        entity: { type: "request_id" },
        top_n: 2,
      },
      fact_prefix: "/result/entity_distribution/",
    },
    {
      role: "team_lead",
      mode: "contributions",
      tool: "count_events",
      input: {
        ...window,
        group_by: ["component"],
        compare: "previous_period",
        contributions: true,
        top_n: 1,
      },
      fact_prefix: "/result/comparison/decomposition/",
    },
    {
      role: "engineer",
      mode: "periodicity",
      tool: "recurring_patterns",
      input: { ...window, analysis: { mode: "periodicity", pattern_id: a } },
      fact_prefix: "/result/analysis/",
    },
    {
      role: "team_lead",
      mode: "cooccurrence",
      tool: "recurring_patterns",
      input: {
        ...window,
        analysis: {
          mode: "cooccurrence",
          pattern_a: a,
          pattern_b: b,
          direction: "either",
          window_seconds: 60,
        },
      },
      fact_prefix: "/result/analysis/",
    },
    {
      role: "team_lead",
      mode: "order",
      tool: "recurring_patterns",
      input: {
        ...window,
        analysis: {
          mode: "cooccurrence",
          pattern_a: a,
          pattern_b: b,
          direction: "after",
          window_seconds: 60,
        },
      },
      fact_prefix: "/result/analysis/",
    },
    {
      role: "engineer",
      mode: "outliers",
      tool: "latency_stats",
      input: { outliers: { threshold: "p95", min_baseline: 20 } },
      fact_prefix: "/result/outliers/",
    },
  ]
  for (const entry of cases) {
    const outcome = await registry.runTool(entry.tool, entry.input, call())
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
    const fact = outcome.result.facts.find(
      (item) =>
        item.path.startsWith(entry.fact_prefix) &&
        typeof item.value === "number"
    )
    if (fact === undefined || typeof fact.value !== "number")
      throw new Error(`Missing numerical fact for ${entry.mode}`)
    const check = await registry.runTool(
      "check_claims",
      {
        claims: [
          {
            fact: fact.id,
            metric: fact.metric,
            value: fact.value,
            group: fact.group,
          },
          {
            fact: fact.id,
            metric: fact.metric,
            value: fact.value + 1,
            group: fact.group,
          },
        ],
      },
      call()
    )
    if (!check.ok) throw new Error(JSON.stringify(check.error))
    const checked = checkClaimsOutputSchema.parse(check.result.data)
    if (
      checked.summary.verified !== 1 ||
      checked.summary.mismatch !== 1 ||
      checked.summary.unresolved !== 0
    )
      throw new Error(`The discriminating claim check failed for ${entry.mode}`)
    await persist(outcome.result.receipt.receipt_id)
    await persist(check.result.receipt.receipt_id)
    records.push({
      intended_role: entry.role,
      mode: entry.mode,
      model_run: false,
      tool_receipt: outcome.result.receipt.receipt_id,
      fact,
      check_receipt: check.result.receipt.receipt_id,
      discriminating_check: check.result.data,
    })
  }
} finally {
  await db.dispose()
}
await writeFile(
  join(directory, "verification.json"),
  `${JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      execution:
        "Real full-corpus registry and SereneDB calls. These are deterministic role-shaped tool chains, not model-generated role answers.",
      blocked_acceptance:
        "ANTHROPIC_API_KEY is absent. Genuine role model runs and provider-backed retrieval quality assessment remain open.",
      records,
    },
    null,
    2
  )}\n`
)
