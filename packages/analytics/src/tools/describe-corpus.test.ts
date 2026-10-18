import type { Receipt } from "@workspace/domain/receipt"
import type { RoleGuidance } from "@workspace/domain/tool"
import { CONTRACT_VERSION } from "@workspace/domain/version"
import { describe, expect, it } from "vitest"

import { createRegistry } from "../registry.ts"
import { describeCorpus } from "./describe-corpus.ts"

/** Rows as SereneDB returns them: BIGINT as strings, JSON lists parsed. */
const ROWS: Record<string, Record<string, unknown>[]> = {
  load_manifest: [
    {
      data_version: "dv_0123456789abcdef",
      source: "samples",
      loader_version: "1.0.0",
      parser_version: "1.0.0",
      pattern_rules_version: "0.1.0-draft",
      ownership_version: "0.1.0-draft",
      rules_version: "concept-3.4",
    },
  ],
  corpus_stats: [
    {
      dataset: "bgl",
      population_count: "3",
      lines_read: "3",
      events: "3",
      rejected: "0",
      first_event: "2005-06-03T22:42:50.675872Z",
      last_event: "2005-06-03T23:00:00.000001Z",
      error_events: "1",
      patterns: "2",
      single_event_patterns: "1",
      time_basis: "Unix seconds",
      label_source: "alert category",
      levels: [
        { level: "INFO", events: 2 },
        { level: "FATAL", events: 1 },
      ],
      components: [
        { component: "KERNEL", team: "Compute Platform", events: 2 },
        { component: "SERV_NET", team: "unowned", events: 1 },
      ],
      labels: [{ label: null, events: 3 }],
      api_accesses: null,
      api_accesses_without_request_id: null,
      requests: null,
    },
  ],
  ownership: [
    {
      dataset: "bgl",
      component: "KERNEL",
      team: "Compute Platform",
      note: "fictional (Serene Platform); draft until U03",
    },
  ],
  // Field guide (U26): per-field value stats computed at load time.
  corpus_field_stats: [
    {
      dataset: "bgl",
      field: "component",
      events_with_value: "3",
      distinct_values: "2",
      examples: [
        { value: "KERNEL", events: 2 },
        { value: "SERV_NET", events: 1 },
      ],
    },
    {
      dataset: "bgl",
      field: "level",
      events_with_value: "3",
      distinct_values: "2",
      examples: [
        { value: "INFO", events: 2 },
        { value: "FATAL", events: 1 },
      ],
    },
    {
      dataset: "bgl",
      field: "node",
      events_with_value: "3",
      distinct_values: "1",
      examples: [{ value: "R02-M1-N0-C:J12-U11", events: 3 }],
    },
  ],
}

const GUIDANCE: RoleGuidance = {
  version: "playbooks-0.1.0",
  routing:
    "Single failure: engineer; recurrence or teams: team lead; priorities: manager; unclear: ask.",
  roles: {
    engineer: "Hypotheses with discriminating checks.",
    team_lead: "Recurring patterns by team.",
    manager: "Priorities by episodes and breadth.",
  },
}

function registry(roleGuidance?: RoleGuidance) {
  const stored: Receipt[] = []
  const db = {
    timeoutMs: 10_000,
    async query(sql: string) {
      const table = Object.keys(ROWS).find((name) =>
        sql.includes(`FROM ${name}`)
      )
      if (table === undefined) throw new Error(`unexpected SQL: ${sql}`)
      return { rows: ROWS[table] ?? [], durationMs: 1 }
    },
  }
  return {
    stored,
    registry: createRegistry({
      db,
      receipts: {
        put: async (receipt) => {
          stored.push(receipt)
        },
        get: async () => null,
        list: async () => [],
      },
      log: () => undefined,
      ...(roleGuidance === undefined ? {} : { roleGuidance }),
    }),
  }
}

const call = { client: "test" as const, signal: new AbortController().signal }

describe("describe_corpus", () => {
  it("returns injected role guidance with its version", async () => {
    const outcome = await registry(GUIDANCE).registry.runTool(
      "describe_corpus",
      {},
      call
    )
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(outcome.result.data).toMatchObject({
      answer_guidance: { routing: GUIDANCE.routing, roles: GUIDANCE.roles },
      guidance_version: "playbooks-0.1.0",
    })
    expect(outcome.result.notes.join(" ")).not.toContain(
      "answer_guidance is null"
    )
  })

  it("returns null guidance with a note instead of placeholder text", async () => {
    const outcome = await registry().registry.runTool(
      "describe_corpus",
      {},
      call
    )
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(outcome.result.data).toMatchObject({
      answer_guidance: null,
      guidance_version: null,
    })
    expect(outcome.result.notes).toContain(
      "answer_guidance is null: this client injected no role playbooks. Follow the server instructions, or ask which role (engineer, team lead, manager) the user has."
    )
  })

  it("lists unowned components, fictional ownership and the versions", async () => {
    const { registry: tools, stored } = registry()
    const outcome = await tools.runTool("describe_corpus", {}, call)
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(describeCorpus.output.parse(outcome.result.data).ownership).toEqual({
      fictional: true,
      note: "fictional (Serene Platform); draft until U03",
      teams: [
        {
          team: "Compute Platform",
          components: [{ dataset: "bgl", component: "KERNEL" }],
        },
      ],
      unowned: [{ dataset: "bgl", component: "SERV_NET", events: 1 }],
    })
    expect(describeCorpus.output.parse(outcome.result.data).versions).toEqual({
      ...ROWS.load_manifest?.[0],
      contract_version: CONTRACT_VERSION,
    })
    expect(stored[0]?.scope.windows).toEqual([
      {
        dataset: "bgl",
        from: "2005-06-03T22:42:50.675872Z",
        to: "2005-06-03T23:00:00.000002Z",
      },
    ])
  })
})
