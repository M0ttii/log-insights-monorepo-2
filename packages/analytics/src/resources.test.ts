import { dbUnavailable } from "@workspace/domain/errors"
import type { ToolResult } from "@workspace/domain/tool"
import { describe, expect, it, vi } from "vitest"

import type { Registry } from "./registry.ts"
import { readCorpusResource } from "./resources.ts"
import { describeCorpus } from "./tools/describe-corpus.ts"

const CAPABILITIES = {
  error_definition: "levels ERROR, SEVERE, FATAL, FAILURE",
  only_errors: true,
  investigation_order: true,
  breadth_unit: "nodes" as const,
  context_scopes: ["same_node", "same_component", "dataset"],
  api_accesses: false,
  labels: "line" as const,
}

const FIELDS = [
  {
    field: "event_id",
    meaning: "Stable event ID.",
    filter: null,
    dimension: null,
    events_with_value: null,
    distinct_values: null,
    examples: [],
  },
  {
    field: "component",
    meaning: "BGL component.",
    filter: "components",
    dimension: "component",
    events_with_value: 3,
    distinct_values: 1,
    examples: [{ value: "KERNEL", events: 3 }],
  },
]

const DATA = describeCorpus.output.parse({
  datasets: [
    {
      dataset: "bgl",
      title: "BGL",
      origin: "BlueGene/L supercomputer.",
      citation: ["Loghub paper."],
      events: 3,
      lines_read: 3,
      rejected: 0,
      first_event: "2005-06-03T22:42:50Z",
      last_event: "2005-06-03T23:00:00Z",
      error_events: 1,
      patterns: 2,
      single_event_patterns: 1,
      time_basis: "Unix seconds",
      label_source: "Dataset alert category",
      fields: FIELDS,
      capabilities: CAPABILITIES,
      levels: [{ level: "INFO", events: 3 }],
      components: [{ component: "KERNEL", team: "unowned", events: 3 }],
      labels: [{ label: null, events: 3 }],
      api_accesses: null,
      api_accesses_without_request_id: null,
      requests: null,
    },
  ],
  license: "Loghub CC BY 4.0.",
  limits: ["Events are not incidents."],
  ownership: {
    fictional: true,
    note: "Fictional ownership.",
    teams: [],
    unowned: [{ dataset: "bgl", component: "KERNEL", events: 3 }],
  },
  versions: {
    data_version: "dv_test",
    source: "samples",
    loader_version: "1.0.0",
    parser_version: "1.0.0",
    pattern_rules_version: "1.0.0",
    ownership_version: "1.0.0",
    rules_version: "1.0.0",
    contract_version: "1.0.0",
  },
  answer_guidance: null,
  guidance_version: null,
})

const RESULT: ToolResult<unknown> = {
  data: DATA,
  facts: [
    {
      id: "r_01234567.f1",
      path: "/result/datasets/0/events",
      value: 3,
      metric: "events",
      unit: "log_events",
      group: { dataset: "bgl" },
    },
  ],
  receipt: {
    receipt_id: "r_01234567",
    input: {},
    signature: "0".repeat(64),
    data_version: "dv_test",
    sql: ["SELECT corpus statistics"],
    params: [[]],
    scope: { windows: [], filters: {} },
    population: { count: 3, unit: "log_events" },
    rows_returned: 1,
    truncated: false,
    duration_ms: 1,
    result_digest: "1".repeat(64),
  },
  notes: ["Teams are fictional."],
}

function setup() {
  const runTool = vi.fn<Registry["runTool"]>().mockResolvedValue({
    ok: true,
    result: RESULT,
  })
  const registry: Registry = {
    tools: [],
    catalog: () => [],
    runTool,
    rerun: vi.fn<Registry["rerun"]>(),
  }
  const call = {
    client: "mcp" as const,
    signal: new AbortController().signal,
  }
  return { registry, runTool, call }
}

describe("corpus resources", () => {
  it("projects the overview through describe_corpus and preserves citations", async () => {
    const { registry, runTool, call } = setup()
    const outcome = await readCorpusResource(registry, "overview", call)
    expect(runTool).toHaveBeenCalledExactlyOnceWith("describe_corpus", {}, call)
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        data: {
          datasets: [{ dataset: "bgl", events: 3 }],
          limits: ["Events are not incidents."],
          versions: DATA.versions,
          answer_guidance: null,
          guidance_version: null,
        },
        facts: RESULT.facts,
        receipt: RESULT.receipt,
        notes: RESULT.notes,
      },
    })
    if (!outcome.ok) throw new Error("expected overview")
    expect(outcome.result.data).not.toHaveProperty("ownership")
    expect(outcome.result.data).not.toHaveProperty("datasets.0.fields")
  })

  it("projects only field meanings per dataset for schema", async () => {
    const { registry, call } = setup()
    const outcome = await readCorpusResource(registry, "schema", call)
    expect(outcome).toEqual({
      ok: true,
      result: {
        ...RESULT,
        data: {
          datasets: [
            {
              dataset: "bgl",
              fields: FIELDS,
              capabilities: CAPABILITIES,
            },
          ],
          versions: DATA.versions,
        },
      },
    })
  })

  it("preserves fictional ownership and unowned component counts", async () => {
    const { registry, call } = setup()
    expect(await readCorpusResource(registry, "ownership", call)).toEqual({
      ok: true,
      result: {
        ...RESULT,
        data: { ownership: DATA.ownership, versions: DATA.versions },
      },
    })
  })

  it("returns expected registry failures without a partial projection", async () => {
    const { registry, runTool, call } = setup()
    const failure = { ok: false as const, error: dbUnavailable() }
    runTool.mockResolvedValue(failure)
    expect(await readCorpusResource(registry, "overview", call)).toBe(failure)
  })

  it("validates the registry data before projecting it", async () => {
    const { registry, runTool, call } = setup()
    runTool.mockResolvedValue({
      ok: true,
      result: { ...RESULT, data: { datasets: [] } },
    })
    await expect(readCorpusResource(registry, "schema", call)).rejects.toThrow(
      "Invalid input"
    )
  })

  it("does not call the registry for an already cancelled resource read", async () => {
    const { registry, runTool, call } = setup()
    const controller = new AbortController()
    const reason = new Error("Cancelled resource read")
    controller.abort(reason)
    await expect(
      readCorpusResource(registry, "overview", {
        ...call,
        signal: controller.signal,
      })
    ).rejects.toBe(reason)
    expect(runTool).not.toHaveBeenCalled()
  })

  it("propagates cancellation that occurs during the registry call", async () => {
    const { registry, runTool, call } = setup()
    const controller = new AbortController()
    const reason = new Error("Cancelled resource read")
    runTool.mockImplementation(async () => {
      controller.abort(reason)
      return { ok: true, result: RESULT }
    })
    await expect(
      readCorpusResource(registry, "overview", {
        ...call,
        signal: controller.signal,
      })
    ).rejects.toBe(reason)
  })
})
