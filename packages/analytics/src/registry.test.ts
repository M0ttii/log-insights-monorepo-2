import { createHash } from "node:crypto"

import { dbUnavailable } from "@workspace/domain/errors"
import { pickFilter, validateFilter } from "@workspace/domain/filters"
import type { Receipt } from "@workspace/domain/receipt"
import {
  defineTool,
  READ_ONLY_ANNOTATIONS,
  type ReceiptStore,
  type ToolContext,
  type ToolRunOutcome,
} from "@workspace/domain/tool"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { QueryFailure } from "./db.ts"
import { ReceiptIdTaken } from "./receipts.ts"
import {
  createRegistry,
  toolEntry,
  ToolFailure,
  type RegistryOptions,
} from "./registry.ts"

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const NOW = "2026-10-17T12:00:00.000Z"
const MANIFEST_SQL = "SELECT data_version FROM load_manifest"

type Answer =
  | Record<string, unknown>[]
  | QueryFailure
  | ((signal: AbortSignal) => Promise<never>)

/** Answers by SQL text; the manifest query is answered unless overridden. */
function fakeDb(answers: Record<string, Answer> = {}) {
  const calls: string[] = []
  return {
    calls,
    timeoutMs: 10_000,
    async query(sql: string, _params: readonly unknown[], signal: AbortSignal) {
      calls.push(sql)
      const answer =
        answers[sql] ??
        (sql === MANIFEST_SQL ? [{ data_version: "dv_test" }] : undefined)
      if (answer === undefined) throw new Error(`unexpected SQL: ${sql}`)
      if (answer instanceof QueryFailure) throw answer
      if (typeof answer === "function") return answer(signal)
      return { rows: answer, durationMs: sql === MANIFEST_SQL ? 100 : 1.25 }
    },
  }
}

function memoryStore() {
  const files = new Map<string, Receipt>()
  const store: ReceiptStore = {
    async put(receipt) {
      if (files.has(receipt.receipt_id))
        throw new ReceiptIdTaken(receipt.receipt_id)
      files.set(receipt.receipt_id, receipt)
    },
    async get(id) {
      return files.get(id) ?? null
    },
    async list() {
      return [...files.keys()].toSorted()
    },
  }
  return { files, store }
}

const COUNT_SQL =
  "SELECT dataset, count(*) AS events FROM log_events WHERE log_events.dataset = $1 GROUP BY dataset ORDER BY dataset"

const inputSchema = z.strictObject({
  ...pickFilter(["dataset"]).shape,
  top_n: z.number().int().min(1).max(5).default(3),
})
const outputSchema = z.strictObject({
  groups: z.array(
    z.strictObject({ dataset: z.string(), events: z.number().int() })
  ),
  text: z.string().optional(),
})
type Input = z.infer<typeof inputSchema>
type Output = z.infer<typeof outputSchema>

/** A small counting tool; `run` can be replaced per test. */
function countTool(
  run?: (ctx: ToolContext, input: Input) => Promise<ToolRunOutcome<Output>>
) {
  return toolEntry(
    defineTool({
      name: "count_test",
      title: "Count test",
      version: "1.0.0",
      description: "Test tool.",
      input: inputSchema,
      output: outputSchema,
      factSpecs: [
        {
          path: "/result/groups/*/events",
          metric: "events",
          unit: "log_events",
          groupKeys: ["dataset"],
        },
      ],
      annotations: READ_ONLY_ANNOTATIONS,
      validate: (input) => validateFilter(input),
      run:
        run ??
        (async (ctx, input) => {
          const dataset = input.dataset ?? "bgl"
          const { rows } = await ctx.db.query(COUNT_SQL, [dataset], ctx.signal)
          await ctx.db.query("SELECT 2", [], ctx.signal)
          return {
            ok: true,
            run: {
              data: {
                groups: rows.map((row) => ({
                  dataset,
                  events: Number(row.events),
                })),
              },
              scope: {
                windows: [
                  {
                    dataset,
                    from: "2005-06-03T00:00:00Z",
                    to: "2005-06-04T00:00:00Z",
                  },
                ],
                filters: {},
              },
              population: { count: 7, unit: "log_events" },
              rows_returned: rows.length,
              truncated: false,
              row_limit: input.top_n,
              notes: ["Counts are log events, not incidents."],
            },
          }
        }),
    })
  )
}

function setup(
  answers: Record<string, Answer> = {},
  overrides: Partial<RegistryOptions> = {}
) {
  const db = fakeDb({
    [COUNT_SQL]: [{ dataset: "bgl", events: "7" }],
    "SELECT 2": [{ two: 2 }],
    ...answers,
  })
  const { files, store } = memoryStore()
  const lines: string[] = []
  const registry = createRegistry({
    db,
    receipts: store,
    clock: { now: () => NOW },
    log: (line) => lines.push(line),
    tools: [countTool()],
    ...overrides,
  })
  return { db, files, lines, registry }
}

const call = (client: "mcp" | "web" | "test" = "test") => ({
  client,
  signal: new AbortController().signal,
})

describe("runTool", () => {
  it("runs the pipeline and stores the receipt before returning", async () => {
    const { files, registry, lines } = setup()
    const outcome = await registry.runTool(
      "count_test",
      { dataset: "bgl" },
      call()
    )
    if (!outcome.ok) throw new Error(outcome.error.message)
    const { receipt, facts, data, notes } = outcome.result
    const id = receipt.receipt_id
    expect(id).toMatch(/^r_[0-9a-f]{8}$/)
    expect(data).toEqual({ groups: [{ dataset: "bgl", events: 7 }] })
    expect(notes).toEqual(["Counts are log events, not incidents."])
    expect(facts).toEqual([
      {
        id: `${id}.f1`,
        path: "/result/groups/0/events",
        value: 7,
        metric: "events",
        unit: "log_events",
        group: { dataset: "bgl" },
      },
    ])
    expect(receipt).toEqual({
      receipt_id: id,
      input: { dataset: "bgl", top_n: 3 },
      signature: sha256(
        '{"input":{"dataset":"bgl","top_n":3},"tool":"count_test","tool_version":"1.0.0"}'
      ),
      data_version: "dv_test",
      // The manifest read is infrastructure, not part of the tool's receipt.
      sql: [COUNT_SQL, "SELECT 2"],
      params: [["bgl"], []],
      scope: {
        windows: [
          {
            dataset: "bgl",
            from: "2005-06-03T00:00:00Z",
            to: "2005-06-04T00:00:00Z",
          },
        ],
        filters: {},
      },
      population: { count: 7, unit: "log_events" },
      rows_returned: 1,
      truncated: false,
      duration_ms: 2.5,
      result_digest: sha256('{"groups":[{"dataset":"bgl","events":7}]}'),
    })
    expect(files.get(id)).toMatchObject({
      created_at: NOW,
      client: "test",
      tool: "count_test",
      tool_version: "1.0.0",
      row_limit: 3,
      result: data,
      facts,
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /^tool=count_test client=test duration_ms=\d+ result_bytes=41 outcome=ok$/
    )
  })

  it("gives the same input the same signature from every client (S-12)", async () => {
    const { registry } = setup()
    const signatures = await Promise.all(
      (["mcp", "web"] as const).map(async (client) => {
        const outcome = await registry.runTool(
          "count_test",
          { top_n: 3, dataset: "bgl" },
          call(client)
        )
        return outcome.ok ? outcome.result.receipt.signature : null
      })
    )
    expect(signatures[0]).not.toBeNull()
    expect(signatures[1]).toBe(signatures[0])
  })

  it("rejects unknown fields and names the accepted ones", async () => {
    const { db, files, registry } = setup()
    const outcome = await registry.runTool(
      "count_test",
      { dataset: "bgl", node: "R02" },
      call()
    )
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "invalid_input",
        message: "Invalid input at node: Unsupported field.",
        hint: "Remove node; this tool does not support it. Accepted fields: dataset, top_n.",
        issues: [{ path: "node", message: "Unsupported field." }],
      },
    })
    expect(db.calls).toEqual([])
    expect(files.size).toBe(0)
  })

  it("runs the cross-field check after the schema parse", async () => {
    let ran = false
    const { registry } = setup(
      {},
      {
        tools: [
          toolEntry(
            defineTool({
              name: "window_test",
              title: "Window test",
              version: "1.0.0",
              description: "Test tool.",
              input: z.strictObject(pickFilter(["from", "to"]).shape),
              output: z.strictObject({}),
              factSpecs: [],
              annotations: READ_ONLY_ANNOTATIONS,
              validate: (input) => validateFilter(input),
              run: () => {
                ran = true
                return Promise.reject(new Error("not reached"))
              },
            })
          ),
        ],
      }
    )
    const outcome = await registry.runTool(
      "window_test",
      { from: "2005-06-04T00:00:00Z", to: "2005-06-03T00:00:00Z" },
      call()
    )
    expect(outcome.ok ? null : outcome.error.code).toBe("invalid_input")
    expect(ran).toBe(false)
  })

  it("reports an unknown tool without logging its name", async () => {
    const { registry, lines } = setup()
    const outcome = await registry.runTool("drop_tables\nfake=1", {}, call())
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      hint: "Use one of: count_test.",
    })
    expect(lines[0]).toMatch(
      /^tool=unknown client=test .* outcome=error=invalid_input$/
    )
  })

  it("passes a tool's own error through without a receipt", async () => {
    const { files, registry } = setup(
      {},
      {
        tools: [
          countTool(async () => ({
            ok: false,
            error: {
              code: "not_found",
              message: "No event.",
              hint: "Use another ID.",
              resource: "event",
              id: "9",
            },
          })),
        ],
      }
    )
    const outcome = await registry.runTool("count_test", {}, call())
    expect(outcome.ok ? null : outcome.error.code).toBe("not_found")
    expect(files.size).toBe(0)
  })

  it("maps a pool timeout to query_timeout", async () => {
    const { files, registry, lines } = setup({
      [COUNT_SQL]: new QueryFailure("timeout", "57014"),
    })
    const outcome = await registry.runTool("count_test", {}, call())
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "query_timeout",
        message: "The query did not finish within 10000 ms and was cancelled.",
        hint: "Narrow the time range, add a dataset or component filter, or use a coarser grouping.",
        timeout_ms: 10_000,
      },
    })
    expect(files.size).toBe(0)
    expect(lines[0]).toMatch(/outcome=error=query_timeout$/)
  })

  it("maps connection loss to db_unavailable", async () => {
    const { registry } = setup({ [COUNT_SQL]: new QueryFailure("unavailable") })
    const outcome = await registry.runTool("count_test", {}, call())
    expect(outcome.ok ? null : outcome.error.code).toBe("db_unavailable")
  })

  it("turns other database failures into a ToolFailure without database text", async () => {
    const { registry, lines } = setup({
      [COUNT_SQL]: new QueryFailure("failed", "42601"),
    })
    const failure = registry.runTool("count_test", {}, call())
    await expect(failure).rejects.toBeInstanceOf(ToolFailure)
    await expect(failure).rejects.toThrow(
      "Tool count_test failed unexpectedly; the cause was logged without details."
    )
    expect(lines[0]).toMatch(/outcome=failed kind=failed sqlstate=42601$/)
  })

  it("rejects with the abort reason and stores nothing when the client cancels", async () => {
    const controller = new AbortController()
    const reason = new Error("client went away")
    const { files, registry, lines } = setup({
      [COUNT_SQL]: (signal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () =>
            reject(new QueryFailure("cancelled"))
          )
          setTimeout(() => controller.abort(reason), 10)
        }),
    })
    await expect(
      registry.runTool(
        "count_test",
        {},
        { client: "mcp", signal: controller.signal }
      )
    ).rejects.toBe(reason)
    expect(files.size).toBe(0)
    expect(lines[0]).toMatch(/outcome=cancelled$/)
  })

  it("stores no receipt when the call is cancelled after run()", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled late")
    const { files, registry } = setup(
      {},
      {
        tools: [
          countTool(async () => {
            controller.abort(reason)
            return {
              ok: true,
              run: {
                data: { groups: [] },
                scope: {
                  windows: [
                    {
                      dataset: "bgl",
                      from: "2005-06-03T00:00:00Z",
                      to: "2005-06-04T00:00:00Z",
                    },
                  ],
                  filters: {},
                },
                population: null,
                rows_returned: 0,
                truncated: false,
                row_limit: null,
                notes: [],
              },
            }
          }),
        ],
      }
    )
    await expect(
      registry.runTool(
        "count_test",
        {},
        { client: "web", signal: controller.signal }
      )
    ).rejects.toBe(reason)
    expect(files.size).toBe(0)
  })

  it("fails with receipt_unavailable when the receipt cannot be written", async () => {
    const { registry, lines } = setup(
      {},
      {
        receipts: {
          put: () =>
            Promise.reject(
              Object.assign(new Error("EACCES: denied"), { code: "EACCES" })
            ),
          get: () => Promise.resolve(null),
          list: () => Promise.resolve([]),
        },
      }
    )
    const outcome = await registry.runTool("count_test", {}, call())
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "receipt_unavailable",
        message:
          "The query receipt could not be stored, so no result is returned.",
        hint: "Results without a stored receipt are not delivered; tell the user and do not cite numbers.",
      },
    })
    expect(lines).toEqual([
      "receipt write failed tool=count_test code=EACCES",
      expect.stringMatching(/outcome=error=receipt_unavailable$/),
    ])
  })

  it("draws a new receipt ID when the first one is taken", async () => {
    const { files, store } = memoryStore()
    let attempts = 0
    const { registry } = setup(
      {},
      {
        receipts: {
          ...store,
          put: (receipt) => {
            attempts += 1
            return attempts === 1
              ? Promise.reject(new ReceiptIdTaken(receipt.receipt_id))
              : store.put(receipt)
          },
        },
      }
    )
    const outcome = await registry.runTool("count_test", {}, call())
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(attempts).toBe(2)
    expect([...files.keys()]).toEqual([outcome.result.receipt.receipt_id])
    expect(outcome.result.facts[0]?.id).toBe(
      `${outcome.result.receipt.receipt_id}.f1`
    )
  })

  it("refuses results above 256 KB", async () => {
    const { files, registry } = setup(
      {},
      {
        tools: [
          countTool(async () => ({
            ok: true,
            run: {
              data: { groups: [], text: "x".repeat(300_000) },
              scope: {
                windows: [
                  {
                    dataset: "bgl",
                    from: "2005-06-03T00:00:00Z",
                    to: "2005-06-04T00:00:00Z",
                  },
                ],
                filters: {},
              },
              population: null,
              rows_returned: 0,
              truncated: false,
              row_limit: null,
              notes: [],
            },
          })),
        ],
      }
    )
    const outcome = await registry.runTool("count_test", {}, call())
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "limit_exceeded",
      limit: 262_144,
      requested: 300_023,
    })
    expect(files.size).toBe(0)
  })

  it("treats output that violates the schema as a tool bug", async () => {
    const { registry } = setup(
      {},
      {
        tools: [
          countTool(async () => ({
            ok: true,
            run: {
              data: { groups: [{ dataset: "bgl", events: 1.5 }] },
              scope: {
                windows: [
                  {
                    dataset: "bgl",
                    from: "2005-06-03T00:00:00Z",
                    to: "2005-06-04T00:00:00Z",
                  },
                ],
                filters: {},
              },
              population: null,
              rows_returned: 0,
              truncated: false,
              row_limit: null,
              notes: [],
            },
          })),
        ],
      }
    )
    await expect(
      registry.runTool("count_test", {}, call())
    ).rejects.toBeInstanceOf(ToolFailure)
  })

  it("reads the data version once per registry", async () => {
    const { db, registry } = setup()
    await registry.runTool("count_test", {}, call())
    await registry.runTool("count_test", {}, call())
    expect(db.calls.filter((sql) => sql === MANIFEST_SQL)).toHaveLength(1)
  })

  it("reports a missing load manifest as db_unavailable with the setup hint", async () => {
    const { db, registry } = setup({
      [MANIFEST_SQL]: new QueryFailure("failed", "42P01"),
    })
    const outcome = await registry.runTool("count_test", {}, call())
    expect(outcome.ok ? null : outcome.error).toEqual({
      code: "db_unavailable",
      message:
        "The corpus is not loaded: this SereneDB database has no load manifest.",
      hint: "Tell the user to run `pnpm data:setup` (or `--samples`) and restart the client; do not retry before that.",
    })
    expect(db.calls).toEqual([MANIFEST_SQL])
  })

  it("logs no input values", async () => {
    const { registry, lines } = setup({
      [COUNT_SQL]: [{ dataset: "openstack", events: "3" }],
    })
    await registry.runTool("count_test", { dataset: "openstack" }, call())
    expect(lines.join("\n")).not.toContain("openstack")
  })
})

describe("rerun", () => {
  it("reruns the stored input and reports matching signature, version and digest", async () => {
    const { db, registry } = setup()
    const first = await registry.runTool(
      "count_test",
      { dataset: "bgl" },
      call("mcp")
    )
    if (!first.ok) throw new Error(first.error.message)
    const rerun = await registry.rerun(
      first.result.receipt.receipt_id,
      call("web")
    )
    if (!rerun.ok) throw new Error(rerun.error.message)
    expect(rerun.original).toEqual(first.result.receipt)
    expect(rerun.result.receipt.receipt_id).not.toBe(
      first.result.receipt.receipt_id
    )
    expect(rerun.matches).toEqual({
      signature: true,
      data_version: true,
      result_digest: true,
    })
    expect(db.calls.filter((sql) => sql === COUNT_SQL)).toHaveLength(2)
  })

  it("reports a different digest when the data changed", async () => {
    let events = 7
    const { registry } = setup(
      {},
      {
        tools: [
          countTool(async () => ({
            ok: true,
            run: {
              data: { groups: [{ dataset: "bgl", events }] },
              scope: {
                windows: [
                  {
                    dataset: "bgl",
                    from: "2005-06-03T00:00:00Z",
                    to: "2005-06-04T00:00:00Z",
                  },
                ],
                filters: {},
              },
              population: null,
              rows_returned: 1,
              truncated: false,
              row_limit: null,
              notes: [],
            },
          })),
        ],
      }
    )
    const first = await registry.runTool("count_test", {}, call())
    if (!first.ok) throw new Error(first.error.message)
    events = 8
    const rerun = await registry.rerun(first.result.receipt.receipt_id, call())
    expect(rerun.ok ? rerun.matches : null).toEqual({
      signature: true,
      data_version: true,
      result_digest: false,
    })
  })

  it("returns not_found for unknown and malformed receipt IDs", async () => {
    const { registry } = setup()
    for (const id of ["r_ffffffff", "../../etc/passwd"]) {
      expect(await registry.rerun(id, call())).toEqual({
        ok: false,
        error: {
          code: "not_found",
          message: `No receipt with ID ${id}.`,
          hint: "Use a receipt ID (r_ + 8 hex digits) returned by a tool in this session.",
          resource: "receipt",
          id,
        },
      })
    }
  })
})

describe("createRegistry", () => {
  it("registers the default tools in a fixed order with unique names", () => {
    const { registry } = setup({}, { tools: undefined })
    const names = registry.tools.map((tool) => tool.name)
    expect(names).toEqual([
      "describe_corpus",
      "search_logs",
      "get_log_context",
      "count_events",
      "event_trend",
      "recurring_patterns",
      "latency_stats",
      "check_claims",
    ])
    expect(new Set(names).size).toBe(names.length)
  })

  it("summarizes through the tool's summary, or returns null without one", async () => {
    const { registry } = setup()
    const outcome = await registry.runTool("count_test", {}, call())
    if (!outcome.ok) throw new Error(outcome.error.message)
    const [entry] = registry.tools
    expect(entry?.summarize(outcome.result)).toBeNull()

    const summarized = toolEntry(
      defineTool({
        name: "summarized_test",
        title: "Summarized test",
        version: "1.0.0",
        description: "Test tool.",
        input: inputSchema,
        output: outputSchema,
        factSpecs: [],
        annotations: READ_ONLY_ANNOTATIONS,
        run: async () => ({ ok: false, error: dbUnavailable() }),
        summary: (result) =>
          `${result.data.groups.length} groups [${result.receipt.receipt_id}]`,
      })
    )
    expect(summarized.summarize(outcome.result)).toBe(
      `1 groups [${outcome.result.receipt.receipt_id}]`
    )
  })

  it("rejects duplicate tool names", () => {
    expect(() => setup({}, { tools: [countTool(), countTool()] })).toThrow(
      "duplicate tool name: count_test"
    )
  })

  it("exports a catalog with JSON Schemas and explicit annotations", () => {
    const { registry } = setup({}, { tools: undefined })
    const [entry] = registry.catalog()
    expect(entry).toMatchObject({
      name: "describe_corpus",
      title: "Describe corpus",
      version: "3.0.0",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      outputSchema: { type: "object", additionalProperties: false },
    })
    expect(entry?.description).toMatch(/^Describes the loaded log corpus/)
    expect(entry?.description).toContain(
      "Use when: call first in every investigation"
    )
    expect(entry?.description).toContain("(use count_events)")
  })

  it("validates injected role guidance", () => {
    expect(() =>
      setup(
        {},
        {
          roleGuidance: {
            version: "",
            routing: "x",
            roles: { engineer: "a", team_lead: "b", manager: "c" },
          },
        }
      )
    ).toThrow(z.ZodError)
  })

  it("does not touch the database until a tool runs", () => {
    const { db } = setup()
    expect(db.calls).toEqual([])
  })
})
