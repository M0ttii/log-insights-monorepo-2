/**
 * The eight tools through the registry against SereneDB with the base 2k
 * samples plus the five Loghub extensions loaded with
 * `pnpm data:setup --samples --with all` (database log_insights_samples_ext,
 * U26/LOG-40).
 *
 * The tools never see SQL; every expectation is either checked against the
 * same SereneDB with an independent query written in the test (so a tool
 * result is compared with a plain count/regex over log_events, never with the
 * tool's own SQL) or is a catalog-driven behaviour (default scope per
 * dataset, breadth unit, which dimensions and filters a dataset allows).
 */
import { rm } from "node:fs/promises"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { checkClaims } from "../../src/tools/check-claims.ts"
import { countEvents } from "../../src/tools/count-events.ts"
import { describeCorpus } from "../../src/tools/describe-corpus.ts"
import { eventTrend } from "../../src/tools/event-trend.ts"
import { getLogContext } from "../../src/tools/get-log-context.ts"
import { recurringPatterns } from "../../src/tools/recurring-patterns.ts"
import { searchLogs } from "../../src/tools/search-logs.ts"
import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import {
  extendedSamplesConnection,
  loadEnv,
  samplesConnection,
  temporaryDir,
} from "./helpers.ts"

loadEnv()

type ExtDataset = "hdfs" | "openssh" | "apache" | "linux" | "zookeeper"
const EXTENSIONS: readonly ExtDataset[] = [
  "hdfs",
  "openssh",
  "apache",
  "linux",
  "zookeeper",
]

/** The first event_id of each dataset (base + 1); the first raw line. */
const FIRST_EVENT: Record<ExtDataset, number> = {
  hdfs: 100_000_001,
  openssh: 200_000_001,
  apache: 300_000_001,
  linux: 400_000_001,
  zookeeper: 500_000_001,
}

/** The default context scope per dataset (catalog; describe_corpus lists them). */
const DEFAULT_SCOPE: Record<ExtDataset, string> = {
  hdfs: "same_block",
  openssh: "same_process",
  apache: "same_component", // the first apache line names no client
  linux: "same_component",
  zookeeper: "same_component",
}

/** The extension columns each dataset carries on an event row. */
const DATASET_ATTRS: Record<ExtDataset, readonly string[]> = {
  hdfs: ["block_id"],
  openssh: ["host", "process_id", "client_ip"],
  apache: ["client_ip"],
  linux: ["host", "process_id"],
  zookeeper: ["thread"],
}

const PROBE_TERM: Record<ExtDataset, string> = {
  hdfs: "block",
  openssh: "password",
  apache: "directory",
  linux: "authentication",
  zookeeper: "connection",
}

const ALL_ATTRS = ["host", "process_id", "client_ip", "thread", "block_id"]

let db: Database
let base: Database
let dir: string
let registry: Registry
let baseRegistry: Registry

beforeAll(async () => {
  db = createDatabase(extendedSamplesConnection())
  base = createDatabase(samplesConnection())
  dir = await temporaryDir("analytics-extensions-")
  registry = createRegistry({
    db,
    receipts: new FileReceiptStore(dir),
    log: () => undefined,
  })
  baseRegistry = createRegistry({
    db: base,
    receipts: new FileReceiptStore(dir),
    log: () => undefined,
  })
})

afterAll(async () => {
  await db.dispose()
  await base.dispose()
  await rm(dir, { recursive: true, force: true })
})

const call = () => ({
  client: "test" as const,
  signal: new AbortController().signal,
})

async function run(
  tool: string,
  input: Record<string, unknown>,
  reg = registry
) {
  return reg.runTool(tool, input, call())
}

async function ok(
  tool: string,
  input: Record<string, unknown>,
  reg = registry
) {
  const outcome = await run(tool, input, reg)
  if (!outcome.ok) throw new Error(`${tool}: ${outcome.error.message}`)
  return outcome.result
}

async function error(
  tool: string,
  input: Record<string, unknown>,
  reg = registry
) {
  const outcome = await run(tool, input, reg)
  if (outcome.ok) throw new Error(`${tool} unexpectedly succeeded`)
  return outcome.error
}

/** An independent count over log_events through the tool's own runner. */
async function count(text: string, values: unknown[] = []): Promise<number> {
  const { rows } = await db.query(text, values, call().signal)
  const row = rows[0] as { n: string | number } | undefined
  return Number(row?.n)
}

describe("the test runs against the extended samples database", () => {
  it("uses log_insights_samples_ext", () => {
    expect(extendedSamplesConnection().database).toBe(
      "log_insights_samples_ext"
    )
  })
})

describe("describe_corpus lists all seven datasets with a field guide", () => {
  it("returns every dataset, each with fields, plus capabilities", async () => {
    const result = await ok("describe_corpus", {})
    const data = describeCorpus.output.parse(result.data)
    expect(data.datasets.map((entry) => entry.dataset)).toEqual([
      "apache",
      "bgl",
      "hdfs",
      "linux",
      "openssh",
      "openstack",
      "zookeeper",
    ])
    for (const entry of data.datasets) {
      expect(Object.keys(entry.fields).length).toBeGreaterThan(0)
      // Each dataset carries its capabilities (scopes, dimensions, …).
      expect(entry).toHaveProperty("capabilities")
    }
  })
})

describe("search_logs", () => {
  for (const dataset of EXTENSIONS) {
    it(`${dataset}: total_matches for "${PROBE_TERM[dataset]}" equals an independent regex count`, async () => {
      const result = await ok("search_logs", {
        dataset,
        query: PROBE_TERM[dataset],
        limit: 1,
      })
      const data = searchLogs.output.parse(result.data)
      const expected = await count(
        `SELECT count(*) AS n FROM log_events
         WHERE dataset = $1 AND regexp_matches(lower(message), $2)`,
        [dataset, `(^|[^a-z0-9_])${PROBE_TERM[dataset]}([^a-z0-9_]|$)`]
      )
      expect(data.total_matches).toBe(expected)
    })
  }
})

describe("get_log_context event mode: default scope and extension attributes", () => {
  for (const dataset of EXTENSIONS) {
    it(`${dataset}: resolves scope ${DEFAULT_SCOPE[dataset]} and carries its attributes on the anchor`, async () => {
      const result = await ok("get_log_context", {
        mode: "event",
        event_id: FIRST_EVENT[dataset],
      })
      const data = getLogContext.output.parse(result.data)
      if (data.mode !== "event") throw new Error("expected event mode")
      expect(data.scope).toBe(DEFAULT_SCOPE[dataset])
      for (const attr of ALL_ATTRS) {
        expect(attr in data.anchor).toBe(DATASET_ATTRS[dataset].includes(attr))
      }
    })
  }

  it("bgl: carries no extension attribute on the anchor", async () => {
    const result = await ok("get_log_context", { mode: "event", event_id: 1 })
    const data = getLogContext.output.parse(result.data)
    if (data.mode !== "event") throw new Error("expected event mode")
    for (const attr of ALL_ATTRS) expect(attr in data.anchor).toBe(false)
  })
})

describe("count_events: totals and group_by equal plain SQL counts", () => {
  const DIM_COLUMN: Record<string, string> = {
    component: "component",
    level: "level",
    client_ip: "client_ip",
    thread: "thread",
    block_id: "block_id",
  }
  const CASES: Array<{ dataset: ExtDataset; dim: string }> = [
    { dataset: "linux", dim: "component" },
    { dataset: "zookeeper", dim: "level" },
    { dataset: "apache", dim: "client_ip" },
    { dataset: "openssh", dim: "client_ip" },
    { dataset: "zookeeper", dim: "thread" },
    { dataset: "hdfs", dim: "block_id" },
  ]
  for (const { dataset, dim } of CASES) {
    it(`${dataset} group_by ${dim}: total and the largest group match SQL`, async () => {
      const result = await ok("count_events", {
        dataset,
        group_by: [dim],
        top_n: 50,
      })
      const data = countEvents.output.parse(result.data)
      const total = await count(
        "SELECT count(*) AS n FROM log_events WHERE dataset = $1",
        [dataset]
      )
      expect(data.total).toBe(total)
      const grouped = data.groups.reduce((sum, group) => sum + group.events, 0)
      const other = data.other?.events ?? 0
      expect(grouped + other).toBe(total)
      // Every extension dataset has at least one group (2,000 events), so the
      // largest group is always present; its count matches a plain grouped
      // count of that value.
      const top = data.groups[0] as Record<string, unknown>
      expect(top).toBeDefined()
      const value = top[dim]
      const column = DIM_COLUMN[dim]
      const sqlCount =
        value === null
          ? await count(
              `SELECT count(*) AS n FROM log_events WHERE dataset = $1 AND ${column} IS NULL`,
              [dataset]
            )
          : await count(
              `SELECT count(*) AS n FROM log_events WHERE dataset = $1 AND ${column} = $2`,
              [dataset, value]
            )
      expect(top["events"]).toBe(sqlCount)
    })
  }
})

describe("event_trend: day buckets sum to the dataset total", () => {
  for (const dataset of EXTENSIONS) {
    it(`${dataset}: the day buckets sum to count(*)`, async () => {
      const result = await ok("event_trend", { dataset, bucket: "day" })
      const data = eventTrend.output.parse(result.data)
      const sum = data.buckets.reduce((acc, bucket) => acc + bucket.events, 0)
      const total = await count(
        "SELECT count(*) AS n FROM log_events WHERE dataset = $1",
        [dataset]
      )
      expect(sum).toBe(total)
    })
  }
})

describe("recurring_patterns: breadth units and investigation_order per dataset", () => {
  it("openssh ranks with the client_ips breadth unit", async () => {
    const result = await ok("recurring_patterns", { dataset: "openssh" })
    const data = recurringPatterns.output.parse(result.data)
    expect(data.rules.breadth_unit).toBe("client_ips")
    expect(data.patterns[0]).toHaveProperty("client_ips")
  })

  it("zookeeper has no breadth unit; breadth is dropped", async () => {
    const result = await ok("recurring_patterns", { dataset: "zookeeper" })
    const data = recurringPatterns.output.parse(result.data)
    expect(data.rules.breadth_unit).toBeNull()
    // ZooKeeper has 57 patterns in scope, so the first is present; it carries
    // no breadth figure because the dataset has no breadth unit.
    const first = data.patterns[0] as Record<string, unknown>
    expect(first).toBeDefined()
    for (const key of [
      "nodes",
      "racks",
      "instances",
      "requests",
      "blocks",
      "client_ips",
    ])
      expect(key in first).toBe(false)
  })

  it("hdfs investigation_order finds no candidates (no error/alert patterns)", async () => {
    const result = await ok("recurring_patterns", {
      dataset: "hdfs",
      rank: "investigation_order",
    })
    const data = recurringPatterns.output.parse(result.data)
    expect(data.pattern_count).toBe(0)
    expect(data.investigation?.candidates_checked).toBe(0)
  })

  it("linux investigation_order with only_errors is invalid (no error definition)", async () => {
    const err = await error("recurring_patterns", {
      dataset: "linux",
      rank: "investigation_order",
      only_errors: true,
    })
    expect(err.code).toBe("invalid_input")
  })
})

describe("dataset-specific validation (A-39, § 8.2)", () => {
  it("latency_stats rejects dataset apache (OpenStack API accesses only)", async () => {
    const err = await error("latency_stats", { dataset: "apache" })
    expect(err.code).toBe("invalid_input")
  })

  it("count_events rejects group_by node for apache (BGL-only dimension)", async () => {
    const err = await error("count_events", {
      dataset: "apache",
      group_by: ["node"],
    })
    expect(err.code).toBe("invalid_input")
  })

  it("search_logs rejects a block_id filter on openssh (HDFS-only filter)", async () => {
    const err = await error("search_logs", {
      dataset: "openssh",
      query: "password",
      block_id: "blk_1",
    })
    expect(err.code).toBe("invalid_input")
  })

  it("a dataset not loaded is invalid input naming the loaded datasets", async () => {
    const err = await error(
      "search_logs",
      { dataset: "hdfs", query: "block" },
      baseRegistry
    )
    expect(err.code).toBe("invalid_input")
    expect(err.message).toContain("bgl, openstack")
  })
})

describe("check_claims verifies a fact from an extension receipt", () => {
  it("resolves the fact a zookeeper search wrote", async () => {
    const search = await ok("search_logs", {
      dataset: "zookeeper",
      query: "connection",
      limit: 1,
    })
    const totalFact = search.facts.find((fact) => fact.metric === "matches")
    if (totalFact === undefined) throw new Error("no matches fact")
    const checked = await ok("check_claims", {
      claims: [
        {
          fact: totalFact.id,
          value: totalFact.value,
          metric: "matches",
          group: {},
        },
      ],
    })
    const data = checkClaims.output.parse(checked.data)
    expect(data.claims.map((claim) => claim.status)).toEqual(["verified"])
    expect(data.summary.checked).toBe(1)
    expect(data.summary.verified).toBe(1)
    expect(data.summary.text).toBe(
      "1 claim checked · 0 mismatch · 0 unresolved"
    )
  })
})
