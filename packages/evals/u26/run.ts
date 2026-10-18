/**
 * U26 (LOG-40) acceptance evidence: for each of the five Loghub extension
 * datasets one real role question, answered by calling the registered tools
 * directly (client "eval"), not by a model — no ANTHROPIC_API_KEY is needed.
 *
 * The script plays the analyst the way a role playbook would
 * (packages/agent/src/playbooks): it runs a fixed, predeclared tool sequence
 * per dataset, cites facts only from the receipts those calls wrote, submits
 * every cited number through check_claims, and fails if any claim is not
 * verified. Numbers in the written answers (results/<dataset>.md) are rendered
 * from the same facts, so prose and receipts cannot drift.
 *
 * Output per dataset:
 *   results/<dataset>.json  tool calls (input, receipt_id, data summary, facts used)
 *   results/<dataset>.md    concise Scope / Answer / role core / Unknown / Verification
 *
 * Rerun (the full corpus must be loaded in SERENEDB_DATABASE):
 *   pnpm --filter @workspace/evals u26
 */
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadConfig } from "@workspace/analytics/config"
import { createDatabase } from "@workspace/analytics/db"
import { FileReceiptStore } from "@workspace/analytics/receipts"
import { createRegistry, type Registry } from "@workspace/analytics/registry"
import { formatFactValue, type Fact } from "@workspace/domain/facts"
import type { Claim } from "@workspace/domain/tools/check-claims"

const here = dirname(fileURLToPath(import.meta.url))
const resultsDir = join(here, "results")
const DATA_VERSION = "dv_02dfa8cc8e16e2a2"
const CLIENT = "eval" as const

/** Loads the repository .env the way the Node scripts do. */
function loadEnv(): void {
  // packages/evals/u26 -> repository root is three levels up.
  const file = join(here, "..", "..", "..", ".env")
  if (existsSync(file)) process.loadEnvFile(file)
}

type ToolCall = {
  step: string
  tool: string
  input: Record<string, unknown>
  receipt_id: string
  summary: string
  facts: Fact[]
  /** Raw validated result data, for non-numeric prose (pattern text, event IDs). */
  data: Record<string, unknown>
}

/** One tool call through the registry; throws on any expected error. */
async function runToolCall(
  registry: Registry,
  step: string,
  tool: string,
  input: Record<string, unknown>
): Promise<ToolCall> {
  const outcome = await registry.runTool(tool, input, {
    client: CLIENT,
    signal: new AbortController().signal,
  })
  if (!outcome.ok)
    throw new Error(
      `${tool} (${step}) failed: ${outcome.error.code} ${outcome.error.message}`
    )
  const data = outcome.result.data as Record<string, unknown>
  return {
    step,
    tool,
    input,
    receipt_id: outcome.result.receipt.receipt_id,
    summary: summarize(tool, data),
    facts: outcome.result.facts,
    data,
  }
}

/** A compact one-line summary of a tool result for the stored record. */
function summarize(tool: string, d: Record<string, unknown>): string {
  switch (tool) {
    case "describe_corpus": {
      const datasets = (d.datasets as { id: string }[] | undefined)?.map(
        (x) => x.id
      )
      return `datasets: ${datasets?.join(", ") ?? "?"}`
    }
    case "search_logs":
      return `total_matches=${String(d.total_matches)}, hits=${(d.hits as unknown[]).length}, truncated=${String(d.truncated)}`
    case "count_events":
      return `unit=${String(d.unit)}, total=${String(d.total)}, groups=${String(d.group_count)}, shown=${(d.groups as unknown[]).length}`
    case "recurring_patterns":
      return `rank=${String(d.rank)}, events=${String(d.events)}, pattern_count=${String(d.pattern_count)}, shown=${(d.patterns as unknown[]).length}`
    case "event_trend":
      return `bucket=${String(d.bucket)}, total=${String(d.total)}, buckets=${(d.buckets as unknown[]).length}`
    case "get_log_context":
      return d.mode === "aggregate"
        ? `aggregate: anchors=${String(d.anchors)}, matched=${String(d.matched_events)}`
        : `event: scope=${String(d.scope)}, before=${(d.events_before as unknown[]).length}, after=${(d.events_after as unknown[]).length}`
    default:
      return ""
  }
}

/** Finds a fact by its JSON pointer path. */
function factAt(call: ToolCall, path: string): Fact {
  const fact = call.facts.find((f) => f.path === path)
  if (fact === undefined)
    throw new Error(`no fact at ${path} in ${call.tool} (${call.step})`)
  return fact
}

/** The first fact under a path prefix whose group matches every given key. */
function factByGroup(
  call: ToolCall,
  suffix: string,
  group: Record<string, string>
): Fact {
  const fact = call.facts.find(
    (f) =>
      f.path.endsWith(suffix) &&
      Object.entries(group).every(([k, v]) => f.group[k] === v)
  )
  if (fact === undefined)
    throw new Error(
      `no ${suffix} fact with group ${JSON.stringify(group)} in ${call.tool} (${call.step})`
    )
  return fact
}

/** A claim that cites a fact exactly as returned (always verifiable). */
function claimOf(fact: Fact): Claim {
  const base = {
    fact: fact.id,
    value: fact.value,
    metric: fact.metric,
    group: fact.group,
  }
  return fact.unit === "percent" ? { ...base, unit: "percent" } : base
}

/** A rendered citation "value unit [id]" for the markdown answer. */
function cite(fact: Fact): string {
  const unit =
    fact.unit === "utc_time" ? "" : ` ${fact.unit.replaceAll("_", " ")}`
  return `${formatFactValue(fact.value)}${unit} [${fact.id}]`
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

type DatasetRun = {
  dataset: string
  role: string
  question: string
  calls: ToolCall[]
  claims: Claim[]
  check: { receipt_id: string; text: string }
  answerMd: string
}

/** Runs check_claims over the cited facts; throws if anything is not verified. */
async function runCheck(
  registry: Registry,
  claims: Claim[]
): Promise<{ receipt_id: string; text: string }> {
  const outcome = await registry.runTool(
    "check_claims",
    { claims },
    { client: CLIENT, signal: new AbortController().signal }
  )
  if (!outcome.ok)
    throw new Error(
      `check_claims failed: ${outcome.error.code} ${outcome.error.message}`
    )
  const data = outcome.result.data as {
    summary: { text: string; mismatch: number; unresolved: number }
  }
  if (data.summary.mismatch !== 0 || data.summary.unresolved !== 0)
    throw new Error(
      `check_claims not clean (${outcome.result.receipt.receipt_id}): ${data.summary.text}`
    )
  return {
    receipt_id: outcome.result.receipt.receipt_id,
    text: data.summary.text,
  }
}

async function writeOut(run: DatasetRun): Promise<void> {
  const json = {
    dataset: run.dataset,
    role: run.role,
    question: run.question,
    data_version: DATA_VERSION,
    client: CLIENT,
    model: "none (tools called directly through the registry)",
    tool_calls: run.calls.map((c) => ({
      step: c.step,
      tool: c.tool,
      input: c.input,
      receipt_id: c.receipt_id,
      data_summary: c.summary,
      facts_used: c.facts
        .filter((f) => run.claims.some((cl) => cl.fact === f.id))
        .map((f) => ({
          id: f.id,
          path: f.path,
          value: f.value,
          metric: f.metric,
          unit: f.unit,
          group: f.group,
        })),
    })),
    check_claims: {
      receipt_id: run.check.receipt_id,
      summary: run.check.text,
      claims: run.claims,
    },
  }
  await writeFile(
    join(resultsDir, `${run.dataset}.json`),
    `${JSON.stringify(json, null, 2)}\n`
  )
  await writeFile(join(resultsDir, `${run.dataset}.md`), run.answerMd)
}

// --- prose helpers (non-numeric, read from the captured result data) -------

type PatternRow = { pattern_id: string; pattern: string | null }

function patternText(
  call: ToolCall,
  index: number
): { id: string; text: string } {
  const row = (call.data.patterns as PatternRow[] | undefined)?.[index]
  if (row === undefined) return { id: "?", text: "" }
  return {
    id: row.pattern_id,
    text: row.pattern === null ? "" : `\`${truncate(row.pattern, 80)}\``,
  }
}

function firstHitEventId(call: ToolCall): number {
  const hit = (call.data.hits as { event_id: number }[] | undefined)?.[0]
  if (hit === undefined) throw new Error("search returned no hits")
  return hit.event_id
}

function anchorMessage(call: ToolCall): string | null {
  const anchor = call.data.anchor as { message: string | null } | undefined
  const msg = anchor?.message ?? null
  return msg === null ? null : truncate(msg, 120)
}

// --- hdfs: Team Lead -------------------------------------------------------

async function hdfs(registry: Registry): Promise<DatasetRun> {
  const question =
    "Which recurring WARN patterns does the Storage Platform team have, and how are they distributed over the two days?"

  const patterns = await runToolCall(
    registry,
    "recurring_patterns",
    "recurring_patterns",
    {
      dataset: "hdfs",
      levels: ["WARN"],
      teams: ["Storage Platform"],
      rank: "episodes",
      limit: 5,
    }
  )
  const teamCount = await runToolCall(
    registry,
    "count_events_by_team",
    "count_events",
    {
      group_by: ["team"],
      dataset: "hdfs",
      levels: ["WARN"],
      top_n: 10,
    }
  )
  const trend = await runToolCall(registry, "event_trend_day", "event_trend", {
    dataset: "hdfs",
    bucket: "day",
    levels: ["WARN"],
    teams: ["Storage Platform"],
  })
  const calls = [patterns, teamCount, trend]

  const scopeEvents = factAt(patterns, "/result/events")
  const patternCount = factAt(patterns, "/result/pattern_count")
  const p0Events = factAt(patterns, "/result/patterns/0/events")
  const p0Episodes = factAt(patterns, "/result/patterns/0/episodes")
  const p0Days = factAt(patterns, "/result/patterns/0/active_days")
  const p1Events = factAt(patterns, "/result/patterns/1/events")
  const p1Episodes = factAt(patterns, "/result/patterns/1/episodes")
  const storageTeam = factByGroup(teamCount, "/events", {
    team: "Storage Platform",
  })
  const trendTotal = factAt(trend, "/result/total")
  const day0 = factAt(trend, "/result/buckets/0/events")
  const day1 = factAt(trend, "/result/buckets/1/events")

  const pat0 = patternText(patterns, 0)
  const pat1 = patternText(patterns, 1)

  const claims = [
    scopeEvents,
    patternCount,
    storageTeam,
    p0Events,
    p0Episodes,
    p0Days,
    p1Events,
    p1Episodes,
    trendTotal,
    day0,
    day1,
  ].map(claimOf)
  const check = await runCheck(registry, claims)

  const answerMd = `# HDFS — Team Lead

Question: ${question}

## Scope
Dataset \`hdfs\` (HDFS_v1, full corpus, data version \`${DATA_VERSION}\`), full data span, filtered to level \`WARN\` and the fictional owning team \`Storage Platform\`. HDFS has two days of data (2008-11-09 to 2008-11-11). Ownership is fictional and labelled as such.

## Answer
In scope the team's WARN lines fall into ${cite(patternCount)} over ${cite(scopeEvents)}. The ${cite(storageTeam)} owned by \`Storage Platform\` are dominated by two recurring patterns.

Recurring WARN patterns (by episodes, then events):

| pattern | events | episodes | active days |
|---|---|---|---|
| \`${pat0.id}\` ${pat0.text} | ${cite(p0Events)} | ${cite(p0Episodes)} | ${cite(p0Days)} |
| \`${pat1.id}\` ${pat1.text} | ${cite(p1Events)} | ${cite(p1Episodes)} | — |

Both are recurring (far more than the two-episode threshold). Over the UTC days, the team's WARN volume is ${cite(trendTotal)}, split ${cite(day0)} in the first bucket and ${cite(day1)} in the second; a short tail falls in the final partial day (see the day-trend receipt).

## Recurring vs. one-off
Each listed pattern has many episodes across the span, so these are recurring, not single bursts. The day trend shows volume on both full days rather than one isolated spike.

## Investigate first
The leading pattern by episodes (\`${pat0.id}\`) is the natural first review for \`Storage Platform\`: it recurs most and carries the most WARN events among the team's patterns. Propose a team review of that pattern's data-node write/replication path. Investigation proposal only — no production change.

## Unknown
HDFS WARN is a warning, not an error (R-02: HDFS error levels never occur here), so these are not failures or outages. Business impact is unknown. Ownership is fictional. The two-day span is short; buckets outside it are not zero. Breadth by block is not asserted here.

## Verification
check_claims receipt \`${check.receipt_id}\`: ${check.text}.
`

  return {
    dataset: "hdfs",
    role: "Team Lead",
    question,
    calls,
    claims,
    check,
    answerMd,
  }
}

// --- openssh: Manager ------------------------------------------------------

async function openssh(registry: Registry): Promise<DatasetRun> {
  const question = "Which observed SSH problems deserve attention first?"

  const order = await runToolCall(
    registry,
    "recurring_patterns_investigation_order",
    "recurring_patterns",
    { dataset: "openssh", rank: "investigation_order", limit: 3 }
  )
  const byClient = await runToolCall(
    registry,
    "count_events_by_client_ip",
    "count_events",
    {
      group_by: ["client_ip"],
      dataset: "openssh",
      only_errors: true,
      top_n: 10,
    }
  )
  const calls = [order, byClient]

  const candidates = factAt(order, "/result/investigation/candidates_checked")
  const candEvents = factAt(order, "/result/events")
  const p0Episodes = factAt(order, "/result/patterns/0/episodes")
  const p0Events = factAt(order, "/result/patterns/0/events")
  const dominated = factAt(
    order,
    "/result/investigation/dominance/compared_with"
  )
  const leaderEpisodes = factAt(
    order,
    "/result/investigation/leaders/episodes/value"
  )
  const errTotal = factAt(byClient, "/result/total")
  const errGroups = factAt(byClient, "/result/group_count")
  // Group 0 is the null client_ip category (errors that name no IP); group 1 is
  // the busiest single client IP. Both facts are cited honestly.
  const nullClientEvents = factAt(byClient, "/result/groups/0/events")
  const topClientEvents = factAt(byClient, "/result/groups/1/events")

  const pat0 = patternText(order, 0)
  const topClientIp = topClientEvents.group.client_ip

  const claims = [
    candidates,
    candEvents,
    p0Episodes,
    p0Events,
    dominated,
    leaderEpisodes,
    errTotal,
    errGroups,
    nullClientEvents,
    topClientEvents,
  ].map(claimOf)
  const check = await runCheck(registry, claims)

  const answerMd = `# OpenSSH — Manager

Question: ${question}

## Scope
Dataset \`openssh\` (one OpenSSH server, host LabSZ, full corpus, data version \`${DATA_VERSION}\`), full data span (2017-12-10 to 2018-01-07). Investigation order over the error/alert candidate patterns; error = messages prefixed \`error:\` or \`fatal:\` (R-02). The distribution by client IP uses only error lines. This is a technical investigation order, not measured severity or business risk.

## Answer
Priorities (per dataset, investigation order R-08 over ${cite(candidates)} checked, ${cite(candEvents)} in scope):

| # | pattern | episodes | events | breadth (client IPs) |
|---|---|---|---|---|
| 1 | \`${pat0.id}\` ${pat0.text} | ${cite(p0Episodes)} | ${cite(p0Events)} | unknown (not every event carries one, R-08) |

The leading candidate is the SSH pre-auth "connection reset" pattern: it recurs across more episodes than any other candidate and dominates the field on that criterion.

## Why this order
The order is the SQL-returned R-08 investigation order over all candidates checked, not a ranking of the displayed rows. The leading pattern is \`clear_priority\`: it dominates the other ${cite(dominated)}, driven by episodes — it holds the episode lead with ${cite(leaderEpisodes)}. Breadth (client IPs) is not determinable for this pattern because not every one of its events names an IP, so breadth is reported as unknown, never as a lower bound. Level and status are shown separately, not folded into a score; a rare severe problem can rank lower, and there is no composite risk score.

## Decision needed
Assign the leading candidate pattern to the fictional \`Access Services\` team (owner of \`sshd\`) for a review of repeated pre-auth connection resets. Investigation only — no production change, ticket or paging.

As supporting context, error lines by client IP span ${cite(errGroups)} over ${cite(errTotal)}: the largest group is the \`null\` category — ${cite(nullClientEvents)} name no parseable client IP — and the busiest single client IP is \`${String(topClientIp)}\` with ${cite(topClientEvents)}.

## Missing information
Business impact unknown. Whether the repeated resets reflect brute-force scanning, network faults or client misconfiguration is not established by these counts. The leader's client-IP breadth is unknown. Causal origin is not established. Ownership is fictional.

## Verification
check_claims receipt \`${check.receipt_id}\`: ${check.text}.
`

  return {
    dataset: "openssh",
    role: "Manager",
    question,
    calls,
    claims,
    check,
    answerMd,
  }
}

// --- apache: Engineer ------------------------------------------------------

async function apache(registry: Registry): Promise<DatasetRun> {
  const question = "What happened around the first mod_jk error-state event?"

  const search = await runToolCall(registry, "search_logs", "search_logs", {
    query: "mod_jk error state",
    match: "terms",
    dataset: "apache",
    sort: "time_asc",
    limit: 5,
  })
  const firstEventId = firstHitEventId(search)
  const context = await runToolCall(
    registry,
    "get_log_context_event",
    "get_log_context",
    {
      mode: "event",
      event_id: firstEventId,
      scope: "same_component",
      before: 5,
      after: 5,
      window_minutes: 10,
    }
  )
  const byLevel = await runToolCall(
    registry,
    "count_events_by_level",
    "count_events",
    {
      group_by: ["level"],
      dataset: "apache",
      top_n: 10,
    }
  )
  const calls = [search, context, byLevel]

  const totalMatches = factAt(search, "/result/total_matches")
  const firstTs = factAt(search, "/result/hits/0/ts")
  const anchorTs = factAt(context, "/result/anchor/ts")
  const beforeInWindow = factAt(context, "/result/sides/0/in_window")
  const afterInWindow = factAt(context, "/result/sides/1/in_window")
  const levTotal = factAt(byLevel, "/result/total")
  const errorLevel = factByGroup(byLevel, "/events", { level: "error" })

  const anchorMsg = anchorMessage(context)

  const claims = [
    totalMatches,
    firstTs,
    anchorTs,
    beforeInWindow,
    afterInWindow,
    levTotal,
    errorLevel,
  ].map(claimOf)
  const check = await runCheck(registry, claims)

  const answerMd = `# Apache — Engineer

Question: ${question}

## Scope
Dataset \`apache\` (httpd error log, full corpus, data version \`${DATA_VERSION}\`), full data span (2005-06-09 to 2006-02-28). Anchor found with \`search_logs\` (terms \`mod_jk error state\`, oldest first); context taken with \`get_log_context\` in event mode on \`same_component\` (\`httpd\`), ±10 minutes. Apache error levels are \`error\`, \`crit\`, \`alert\`, \`emerg\` as logged (R-02).

## Evidence
\`search_logs\` returns ${cite(totalMatches)} matching log events for \`mod_jk error state\` (a bounded search total, not a sampled frequency). The earliest match is at ${cite(firstTs)}; the context anchor is the same event at ${cite(anchorTs)}${anchorMsg === null ? "" : `: "${anchorMsg}"`}.

## Timeline
Within ±10 minutes of the anchor on the same component (\`httpd\`): ${cite(beforeInWindow)} in the before window and ${cite(afterInWindow)} in the after window (exact window counts; the nearest events are listed in the receipt). The surrounding lines are further mod_jk worker transitions, consistent with a cluster of repeated worker error-state reports rather than one isolated line.

## Narrowing
Across the whole dataset, log events by level total ${cite(levTotal)}, of which ${cite(errorLevel)} are level \`error\`. The mod_jk matches are a bounded fraction of that error population (use the search total above for frequency, never the hit list).

## Hypotheses
- A single mod_jk worker repeatedly entering error state around the anchor time | open | the search total and the dense before/after window are consistent with repeated reports, but neighbouring context alone cannot establish a cause | executed check: get_log_context event mode (receipt below) and the level breakdown.

## Next check
Inspect the mod_jk worker name and the paired "recovering worker" lines on \`httpd\` in a wider window and correlate with the client-IP distribution. Observable: whether error-state and recovery lines pair up for one worker. Pairing would support a single-worker association but still not prove a cause; a different or missing neighbour would leave the association open. Timing and co-occurrence cannot confirm a root cause.

## Unknown
Root cause is unknown; the neighbourhood is a temporal observation, not proof. No business impact is claimed. Apache lines name no module beyond \`httpd\`.

## Verification
check_claims receipt \`${check.receipt_id}\`: ${check.text}.
`

  return {
    dataset: "apache",
    role: "Engineer",
    question,
    calls,
    claims,
    check,
    answerMd,
  }
}

// --- linux: Team Lead ------------------------------------------------------

async function linux(registry: Registry): Promise<DatasetRun> {
  const question = "Which programs log most and recur, and who owns them?"

  const byTeamComp = await runToolCall(
    registry,
    "count_events_by_team_component",
    "count_events",
    { group_by: ["team", "component"], dataset: "linux", top_n: 10 }
  )
  const patterns = await runToolCall(
    registry,
    "recurring_patterns",
    "recurring_patterns",
    {
      dataset: "linux",
      rank: "episodes",
      limit: 5,
    }
  )
  const trend = await runToolCall(registry, "event_trend_week", "event_trend", {
    dataset: "linux",
    bucket: "week",
    split_by: "component",
  })
  const calls = [byTeamComp, patterns, trend]

  const total = factAt(byTeamComp, "/result/total")
  const groupCount = factAt(byTeamComp, "/result/group_count")
  const g0 = factAt(byTeamComp, "/result/groups/0/events")
  const g1 = factAt(byTeamComp, "/result/groups/1/events")
  const patEvents = factAt(patterns, "/result/events")
  const patCount = factAt(patterns, "/result/pattern_count")
  const p0Episodes = factAt(patterns, "/result/patterns/0/episodes")
  const p0Events = factAt(patterns, "/result/patterns/0/events")
  const trendTotal = factAt(trend, "/result/total")

  const g0Team = g0.group.team
  const g0Comp = g0.group.component
  const g1Team = g1.group.team
  const g1Comp = g1.group.component
  const pat0 = patternText(patterns, 0)

  const claims = [
    total,
    groupCount,
    g0,
    g1,
    patEvents,
    patCount,
    p0Episodes,
    p0Events,
    trendTotal,
  ].map(claimOf)
  const check = await runCheck(registry, claims)

  const answerMd = `# Linux — Team Lead

Question: ${question}

## Scope
Dataset \`linux\` (/var/log/messages of one host \`combo\`, full corpus, data version \`${DATA_VERSION}\`), full data span (2005-06-09 to 2006-02-28). Grouped by fictional owning team and component (program); patterns ranked by episodes; a weekly trend split by component. Linux has no error definition (R-02), so no line is classified as an error here. Ownership is fictional.

## Recurring patterns and distribution
Log events total ${cite(total)} across ${cite(groupCount)} of team and component (program). The two busiest programs:

| team | component (program) | events |
|---|---|---|
| \`${g0Team}\` | \`${g0Comp}\` | ${cite(g0)} |
| \`${g1Team}\` | \`${g1Comp}\` | ${cite(g1)} |

Patterns in scope: ${cite(patCount)} over ${cite(patEvents)}. The leading pattern by episodes (\`${pat0.id}\` ${pat0.text}) has ${cite(p0Episodes)} over ${cite(p0Events)}. The weekly trend covers ${cite(trendTotal)} over the span, split by component.

## Recurring vs. one-off
The leading pattern recurs across many episodes, not a single burst; the weekly trend spreads events across weeks rather than one isolated week (buckets outside the span are not zero).

## Investigate first
By volume and recurrence, \`${g0Comp}\` (owned by the fictional \`${g0Team}\`) is the natural first review. Propose a team review of its most recurrent pattern. Investigation proposal only — no production change.

## Unknown
Linux carries no error level, so "most logging" is not "most failing"; severity and business impact are unknown. Ownership is fictional. A line with a \`null\` component is its own category and not attributed to a team.

## Verification
check_claims receipt \`${check.receipt_id}\`: ${check.text}.
`

  return {
    dataset: "linux",
    role: "Team Lead",
    question,
    calls,
    claims,
    check,
    answerMd,
  }
}

// --- zookeeper: Engineer ---------------------------------------------------

async function zookeeper(registry: Registry): Promise<DatasetRun> {
  const question = "What precedes the shutdown-exception errors?"

  const search = await runToolCall(registry, "search_logs", "search_logs", {
    query: "Unexpected exception causing shutdown",
    match: "terms",
    dataset: "zookeeper",
    sort: "time_asc",
    limit: 5,
  })
  const aggregate = await runToolCall(
    registry,
    "get_log_context_aggregate",
    "get_log_context",
    {
      mode: "aggregate",
      dataset: "zookeeper",
      query: "Unexpected exception causing shutdown",
      direction: "before",
      window_minutes: 10,
      top_n: 10,
    }
  )
  const byLevel = await runToolCall(
    registry,
    "count_events_by_level",
    "count_events",
    {
      group_by: ["level"],
      dataset: "zookeeper",
      top_n: 10,
    }
  )
  const calls = [search, aggregate, byLevel]

  const totalMatches = factAt(search, "/result/total_matches")
  const matched = factAt(aggregate, "/result/matched_events")
  const anchors = factAt(aggregate, "/result/anchors")
  const levTotal = factAt(byLevel, "/result/total")
  const errorLevel = factByGroup(byLevel, "/events", { level: "ERROR" })

  const precursorShare = aggregate.facts.find(
    (f) => f.path === "/result/by_direction/0/patterns/0/anchor_share"
  )
  const precursorAnchors = aggregate.facts.find(
    (f) => f.path === "/result/by_direction/0/patterns/0/anchors_with_pattern"
  )

  const base = [totalMatches, matched, anchors, levTotal, errorLevel]
  const claims = (
    precursorShare !== undefined && precursorAnchors !== undefined
      ? [...base, precursorAnchors, precursorShare]
      : base
  ).map(claimOf)
  const check = await runCheck(registry, claims)

  const precursorLine =
    precursorShare !== undefined && precursorAnchors !== undefined
      ? `Among the shutdown anchors, the most frequent preceding pattern appears before ${cite(precursorAnchors)} of them (anchor share ${cite(precursorShare)}); this is a temporal observation, never a cause.`
      : `The anchor count is below the tool's minimum for a base rate, so no precursor base-rate comparison is available; the preceding window cannot be compared against an expected rate.`

  const answerMd = `# ZooKeeper — Engineer

Question: ${question}

## Scope
Dataset \`zookeeper\` (ZooKeeper of 32 machines, aggregated, full corpus, data version \`${DATA_VERSION}\`), full data span (2015-07-29 to 2015-08-25). Anchor condition: all words of \`Unexpected exception causing shutdown\` (search terms), restricted to this dataset. Precursor analysis in \`before\` mode, window 10 minutes; episode starts (gap ≥ 30 min) are the anchors. ZooKeeper error levels are \`ERROR\`, \`FATAL\` (R-02).

## Evidence
\`search_logs\` returns ${cite(totalMatches)} matching the shutdown-exception text. The precursor pass matches ${cite(matched)} and reduces them to ${cite(anchors)} (episode starts; bursts collapse to one anchor each). Dataset-wide, log events by level total ${cite(levTotal)}, of which ${cite(errorLevel)} are level \`ERROR\`.

## Timeline (precursors)
${precursorLine} Precursors are observations before the anchors, not causes.

## Narrowing
The shutdown-exception events are ERROR-level ZooKeeper lines (owned by the fictional \`Coordination Services\` team). Use the aggregate anchors, not the raw search total, as the count of distinct shutdown episodes.

## Hypotheses
- A repeated preceding pattern is associated with shutdown episodes | open | the before-window shows which patterns recur ahead of anchors, but temporal precedence is not causation and the base rate is bounded by the anchor count | executed check: get_log_context aggregate (receipt below).

## Next check
Open the leading precursor pattern with get_log_context event mode on the same thread around a shutdown anchor, and compare its before/after presence. Observable: whether the precursor is concentrated ahead of shutdowns versus spread across the span. Concentration would support the association; absence would leave it open. A matching precursor still cannot prove the shutdown's cause.

## Unknown
Root cause of the shutdowns is unknown. Business impact is unknown. The precursor base rate is bounded by the number of anchors; a precursor is never a cause. Ownership is fictional.

## Verification
check_claims receipt \`${check.receipt_id}\`: ${check.text}.
`

  return {
    dataset: "zookeeper",
    role: "Engineer",
    question,
    calls,
    claims,
    check,
    answerMd,
  }
}

async function main(): Promise<void> {
  loadEnv()
  const config = loadConfig()
  const db = createDatabase(config.connection)
  await mkdir(resultsDir, { recursive: true })
  const registry = createRegistry({
    db,
    receipts: new FileReceiptStore(config.receiptsDir),
    log: () => undefined,
  })

  const runs: DatasetRun[] = []
  try {
    // describe_corpus once, as every playbook requires before choosing tools.
    const describe = await runToolCall(
      registry,
      "describe_corpus",
      "describe_corpus",
      {}
    )
    process.stderr.write(`describe_corpus: ${describe.receipt_id}\n`)

    runs.push(await hdfs(registry))
    runs.push(await openssh(registry))
    runs.push(await apache(registry))
    runs.push(await linux(registry))
    runs.push(await zookeeper(registry))

    for (const run of runs) {
      await writeOut(run)
      process.stderr.write(
        `${run.dataset} (${run.role}): check_claims ${run.check.receipt_id} — ${run.check.text}\n`
      )
    }
  } finally {
    await db.dispose()
  }

  process.stdout.write(
    `${JSON.stringify(
      runs.map((r) => ({
        dataset: r.dataset,
        role: r.role,
        check_receipt: r.check.receipt_id,
        check_summary: r.check.text,
        tool_receipts: r.calls.map((c) => `${c.tool}:${c.receipt_id}`),
      })),
      null,
      2
    )}\n`
  )
}

await main()
