import type {
  CallContext,
  Registry,
  ToolEntry,
} from "@workspace/analytics/registry"
import { ToolFailure } from "@workspace/analytics/registry"
import { invalidInput } from "@workspace/domain/errors"
import type { Fact } from "@workspace/domain/facts"
import type { ToolResult } from "@workspace/domain/tool"
import { z } from "zod"
import { describe, expect, it } from "vitest"

import { buildTools, modelView, type ToolExecuteResult } from "./tools.ts"

import type { ToolSet } from "ai"

function getTool(tools: ToolSet, name: string) {
  const t = tools[name]
  if (t === undefined) throw new Error(`missing tool: ${name}`)
  return t
}

const FACT: Fact = {
  id: "r_12345678.f1",
  path: "/result/count",
  value: 1204,
  metric: "events",
  unit: "log_events",
  group: { dataset: "bgl" },
}

function okResult(): ToolResult<unknown> {
  return {
    data: { count: 1204 },
    facts: [FACT],
    notes: ["counts are log entries, not incidents"],
    receipt: {
      receipt_id: "r_12345678",
      input: { dataset: "bgl" },
      signature: "a".repeat(64),
      data_version: "dv_test",
      sql: ["SELECT count(*) FROM log_events"],
      params: [["bgl"]],
      scope: { windows: [], filters: {} },
      population: null,
      rows_returned: 1,
      truncated: true,
      duration_ms: 3,
      result_digest: "b".repeat(64),
    },
  }
}

/** A tool entry whose only used fields are name/description/inputSchema. */
function entry(name: string): ToolEntry {
  return {
    name,
    title: name,
    version: "1.0.0",
    description: `desc for ${name}`,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.strictObject({ dataset: z.string() }),
    outputSchema: z.unknown(),
    execute: () => {
      throw new Error("not used by the adapter")
    },
    summarize: () => null,
  }
}

/** A fake registry with a scripted runTool; no DB, no pool. */
function fakeRegistry(names: string[], run: Registry["runTool"]): Registry {
  return {
    tools: names.map(entry),
    catalog: () => [],
    runTool: run,
    rerun: async () => ({ ok: false, error: invalidInput([]) }),
  }
}

const ctx = (signal: AbortSignal): CallContext => ({ client: "test", signal })

describe("buildTools", () => {
  it("builds one tool per registry entry in the registry's order", () => {
    const registry = fakeRegistry(
      ["describe_corpus", "search_logs", "count_events"],
      async () => ({ ok: true, result: okResult() })
    )
    const tools = buildTools(registry, ctx)
    expect(Object.keys(tools)).toEqual([
      "describe_corpus",
      "search_logs",
      "count_events",
    ])
  })

  it("keeps the tool key order byte-stable across builds", () => {
    const registry = fakeRegistry(["a", "b", "c"], async () => ({
      ok: true,
      result: okResult(),
    }))
    const first = JSON.stringify(Object.keys(buildTools(registry, ctx)))
    const second = JSON.stringify(Object.keys(buildTools(registry, ctx)))
    expect(first).toBe(second)
  })

  it("execute calls runTool with the name, input and the abort signal", async () => {
    const seen: { name: string; input: unknown; aborted: boolean }[] = []
    const registry = fakeRegistry(
      ["count_events"],
      async (name, input, call) => {
        seen.push({ name, input, aborted: call.signal.aborted })
        return { ok: true, result: okResult() }
      }
    )
    const controller = new AbortController()
    const tools = buildTools(registry, () => ctx(controller.signal))
    const tool = getTool(tools, "count_events")
    const out = (await tool.execute?.(
      { dataset: "bgl" },
      {
        toolCallId: "t1",
        messages: [],
        abortSignal: controller.signal,
        context: undefined,
      }
    )) as ToolExecuteResult
    expect(seen).toEqual([
      { name: "count_events", input: { dataset: "bgl" }, aborted: false },
    ])
    expect(out.ok).toBe(true)
  })

  it("the model view is compact: data, facts, notes, truncated, receipt_id, no SQL/params", () => {
    const view = modelView(okResult())
    expect(view).toEqual({
      data: { count: 1204 },
      facts: [
        {
          id: "r_12345678.f1",
          metric: "events",
          value: 1204,
          unit: "log_events",
          group: { dataset: "bgl" },
        },
      ],
      notes: ["counts are log entries, not incidents"],
      truncated: true,
      receipt_id: "r_12345678",
    })
    expect(JSON.stringify(view)).not.toContain("SELECT")
    expect(JSON.stringify(view)).not.toContain("params")
  })

  it("toModelOutput emits the compact view for a success", async () => {
    const registry = fakeRegistry(["count_events"], async () => ({
      ok: true,
      result: okResult(),
    }))
    const tools = buildTools(registry, ctx)
    const tool = getTool(tools, "count_events")
    const out = (await tool.execute?.(
      { dataset: "bgl" },
      {
        toolCallId: "t1",
        messages: [],
        abortSignal: new AbortController().signal,
        context: undefined,
      }
    )) as ToolExecuteResult
    const model = tool.toModelOutput?.({
      toolCallId: "t1",
      input: { dataset: "bgl" },
      output: out,
    })
    expect(model).toEqual({ type: "json", value: modelView(okResult()) })
  })

  it("returns an expected failure as a value with kind/message/hint, never a throw", async () => {
    const error = invalidInput([{ path: "dataset", message: "bad" }])
    const registry = fakeRegistry(["count_events"], async () => ({
      ok: false,
      error,
    }))
    const tools = buildTools(registry, ctx)
    const tool = getTool(tools, "count_events")
    const out = (await tool.execute?.(
      { dataset: 1 },
      {
        toolCallId: "t1",
        messages: [],
        abortSignal: new AbortController().signal,
        context: undefined,
      }
    )) as ToolExecuteResult
    expect(out.ok).toBe(false)
    const model = tool.toModelOutput?.({
      toolCallId: "t1",
      input: {},
      output: out,
    }) as {
      type: string
      value: { error: { kind: string; message: string; hint: string } }
    }
    expect(model.value.error.kind).toBe("invalid_input")
    expect(model.value.error.hint).toBe(error.hint)
    expect(JSON.stringify(model)).not.toContain("stack")
  })

  it("maps an unexpected ToolFailure to a generic sanitized error value", async () => {
    const registry = fakeRegistry(["count_events"], async () => {
      throw new ToolFailure("count_events")
    })
    const tools = buildTools(registry, ctx)
    const tool = getTool(tools, "count_events")
    const out = (await tool.execute?.(
      { dataset: "bgl" },
      {
        toolCallId: "t1",
        messages: [],
        abortSignal: new AbortController().signal,
        context: undefined,
      }
    )) as ToolExecuteResult
    expect(out.ok).toBe(false)
    const failure = out as Extract<ToolExecuteResult, { ok: false }>
    expect(failure.error.error.message).toBe("The tool failed unexpectedly.")
  })

  it("rethrows when the signal is aborted (cancellation propagates)", async () => {
    const controller = new AbortController()
    const registry = fakeRegistry(["count_events"], async () => {
      controller.abort(new Error("cancelled"))
      throw controller.signal.reason
    })
    const tools = buildTools(registry, () => ctx(controller.signal))
    const tool = getTool(tools, "count_events")
    await expect(
      tool.execute?.(
        { dataset: "bgl" },
        {
          toolCallId: "t1",
          messages: [],
          abortSignal: controller.signal,
          context: undefined,
        }
      )
    ).rejects.toThrow("cancelled")
  })
})
