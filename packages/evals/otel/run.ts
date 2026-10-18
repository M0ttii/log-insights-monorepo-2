/** LOG-35 development evidence: predeclared role questions, real tools, no model. */
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadConfig } from "@workspace/analytics/config"
import { createDatabase } from "@workspace/analytics/db"
import { FileReceiptStore } from "@workspace/analytics/receipts"
import { createRegistry, type Registry } from "@workspace/analytics/registry"
import { DATASETS } from "@workspace/domain/datasets"
import { formatFactValue, type Fact } from "@workspace/domain/facts"
import type { ToolResult } from "@workspace/domain/tool"
import {
  checkClaimsOutputSchema,
  type Claim,
} from "@workspace/domain/tools/check-claims"
import { searchLogsOutputSchema } from "@workspace/domain/tools/search-logs"

const resultsDir = fileURLToPath(new URL("./results/", import.meta.url))
const window = DATASETS.otel.remote.reference
const scope = { dataset: "otel", from: window.from, to: window.to }
const roles = ["engineer", "team_lead", "manager"] as const
const questions = {
  engineer:
    "What evidence surrounds the earliest visa cache full log, and which cause hypothesis remains open?",
  team_lead:
    "Which services report visa cache full in the reference window, and what should a team review check?",
  manager:
    "Does the visa cache full evidence support a management priority, and what evidence is missing?",
}

type Call = {
  tool: string
  input: Record<string, unknown>
  result: ToolResult<unknown>
}
async function call(
  registry: Registry,
  tool: string,
  input: Record<string, unknown>
): Promise<Call> {
  const outcome = await registry.runTool(tool, input, {
    client: "eval",
    signal: new AbortController().signal,
  })
  if (!outcome.ok)
    throw new Error(`${tool}: ${outcome.error.code}: ${outcome.error.message}`)
  return { tool, input, result: outcome.result }
}
function factAt(step: Call, path: string): Fact {
  const fact = step.result.facts.find((entry) => entry.path === path)
  if (fact === undefined) throw new Error(`${step.tool} has no fact at ${path}`)
  return fact
}
function claimOf(fact: Fact): Claim {
  return {
    fact: fact.id,
    value: fact.value,
    metric: fact.metric,
    group: fact.group,
  }
}
function cite(fact: Fact): string {
  return `${formatFactValue(fact.value)} [${fact.id}]`
}

async function runRole(
  registry: Registry,
  role: (typeof roles)[number]
): Promise<void> {
  const describe = await call(registry, "describe_corpus", {})
  const search = await call(registry, "search_logs", {
    ...scope,
    query: "visa cache full",
    match: "terms",
    sort: "time_asc",
    limit: 1,
  })
  const counts = await call(registry, "count_events", {
    ...scope,
    text: "visa cache full",
    group_by: ["component"],
    top_n: 20,
  })
  const calls = [describe, search, counts]
  const total = factAt(counts, "/result/total")
  const from = factAt(counts, "/scope/windows/0/from")
  const to = factAt(counts, "/scope/windows/0/to")
  const used = [total, from, to]
  const groupFacts = counts.result.facts.filter((fact) =>
    /^\/result\/groups\/\d+\/events$/.test(fact.path)
  )
  used.push(...groupFacts)
  const groupRows = groupFacts
    .map((fact) => `| ${String(fact.group["component"])} | ${cite(fact)} |`)
    .join("\n")
  let core: string
  if (role === "engineer") {
    const hit = searchLogsOutputSchema.parse(search.result.data).hits[0]
    if (hit === undefined) throw new Error("OTel search has no anchor")
    const context = await call(registry, "get_log_context", {
      mode: "event",
      event_id: hit.event_id,
      scope: "same_component",
      before: 2,
      after: 2,
      window_minutes: 1,
    })
    calls.push(context)
    const before = factAt(context, "/result/sides/0/in_window")
    const after = factAt(context, "/result/sides/1/in_window")
    used.push(before, after)
    core = `## Timeline and hypothesis\nThe anchor's service has ${cite(before)} preceding and ${cite(after)} following log events in the requested context, clipped to the indexed reference window. These are temporal observations.\n\nHypothesis: a service-local cache limit is associated with these messages. Status: open. Executed discriminating check: same-component context around the earliest match. Neighbouring logs alone cannot establish cache capacity or causation. Next check: inspect the matching service's actual cache metrics and configuration at the anchor time; those signals are not loaded here.`
  } else {
    const trend = await call(registry, "event_trend", {
      ...scope,
      text: "visa cache full",
      bucket: "second",
      split_by: "component",
    })
    calls.push(trend)
    const trendTotal = factAt(trend, "/result/total")
    used.push(trendTotal)
    core =
      role === "team_lead"
        ? `## Distribution and proposed team review\nThe second-bucket trend covers ${cite(trendTotal)} matching log events and separates services. Service ownership is unknown: all OTel services are \`unowned\`. Propose that a human identifies the owners and compares the service timelines with their cache instrumentation. Recurrence and pattern episodes are unsupported for this dataset, so a repeated message is not an established recurring incident.`
        : `## Priority and trade-offs\nThe checked service trend covers ${cite(trendTotal)} matching log events. This is a volume distribution. Management priority cannot be established: episode counts and breadth are unavailable, and R-08/R-09 cannot rank services by log volume. Keep priority undetermined. Proposed next step: request independent episode and breadth evidence and identify accountable owners. A volume-heavy service may still have fewer separate episodes; that trade-off is unresolved.`
  }
  const claims = used.map(claimOf)
  const checked = await call(registry, "check_claims", { claims })
  const verification = checkClaimsOutputSchema.parse(checked.result.data)
  if (
    verification.summary.mismatch !== 0 ||
    verification.summary.unresolved !== 0 ||
    verification.claims.some((claim) => claim.status !== "verified")
  ) {
    throw new Error(
      `unclean check_claims for ${role}: ${verification.summary.text}`
    )
  }
  const checkedCount = factAt(checked, "/result/summary/checked")
  const mismatchCount = factAt(checked, "/result/summary/mismatch")
  const unresolvedCount = factAt(checked, "/result/summary/unresolved")
  const verificationLine = `${cite(checkedCount)} claims checked · ${cite(mismatchCount)} mismatch · ${cite(unresolvedCount)} unresolved`
  const version = counts.result.receipt.data_version
  const answer = `# OTel — ${role}\n\nDevelopment evidence composed from real tool results without a model; not the role eval, baseline, holdout or an independent rating.\n\nQuestion: ${questions[role]}\n\n## Scope\nDataset \`otel\`, [${cite(from)}, ${cite(to)}), UTC, part_000 and part_001 only. Data version \`${version}\`. The reference removes the shared boundary duplicate; no statement covers the other files or the entire day.\n\n## Answer\nThe aggregation returns ${cite(total)} matching log events. Search supplies an anchor, while frequencies come from count_events.\n\n| service | matching log events |\n|---|---:|\n${groupRows}\n\n${core}\n\n## Unknown\nRoot cause, incident/outage count, business impact, downtime and customer effects are unknown. Trace IDs in logs do not provide loaded trace spans or metrics. Tool facts verify numbers, metrics and groups, never explanations.\n\n## Verification\n${verificationLine}. check_claims receipt \`${checked.result.receipt.receipt_id}\`.\n`
  await mkdir(resultsDir, { recursive: true })
  await writeFile(join(resultsDir, `${role}.md`), answer)
  await writeFile(
    join(resultsDir, `${role}.json`),
    `${JSON.stringify(
      {
        dataset: "otel",
        role,
        question: questions[role],
        data_version: version,
        method:
          "development evidence; tools called directly; no model or role-eval rating",
        tool_calls: calls.map((step) => ({
          tool: step.tool,
          input: step.result.receipt.input,
          receipt: step.result.receipt,
          notes: step.result.notes,
          facts_used: step.result.facts.filter((fact) =>
            used.some((entry) => entry.id === fact.id)
          ),
        })),
        check_claims: {
          receipt: checked.result.receipt,
          facts: checked.result.facts,
          claims,
          summary: verification.summary,
        },
      },
      null,
      2
    )}\n`
  )
  process.stdout.write(
    `${role}: ${verification.summary.text} (${checked.result.receipt.receipt_id})\n`
  )
}

async function main(): Promise<void> {
  const config = loadConfig()
  const db = createDatabase(config.connection)
  const registry = createRegistry({
    db,
    receipts: new FileReceiptStore(config.receiptsDir),
    log: () => undefined,
  })
  try {
    for (const role of roles) await runRole(registry, role)
  } finally {
    await db.dispose()
  }
}
await main()
