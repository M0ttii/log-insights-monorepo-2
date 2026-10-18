import type { CallContext, Registry } from "@workspace/analytics/registry"
import type { ToolError } from "@workspace/domain/errors"
import type { Fact } from "@workspace/domain/facts"
import type { ToolResult } from "@workspace/domain/tool"
import { tool, type JSONValue, type Tool, type ToolSet } from "ai"

/**
 * Registry → AI SDK tool adapter (technical.md § 11.1, "Tool-Adapter"): the
 * AI SDK tools are built from `registry.tools`, with no own list. `inputSchema`
 * is the registry's Zod schema; `execute` calls `registry.runTool(name, input,
 * callContext(signal))` with the abort signal from the AI SDK execute options.
 *
 * API names read from the installed `ai` 7.0.143 / `@ai-sdk/provider-utils`
 * 5.0.62:
 * - `tool({ description, inputSchema, execute, toModelOutput })`
 *   (dist/index.d.ts re-exports `tool$1 as tool`; `FunctionTool` in
 *   @ai-sdk/provider-utils/dist/index.d.ts carries `inputSchema`, `execute`,
 *   `toModelOutput`).
 * - `execute(input, options)` where `options: ToolExecutionOptions` has
 *   `abortSignal?: AbortSignal` (same provider-utils file).
 * - `toModelOutput({ toolCallId, input, output })` returning
 *   `{ type: "json", value } | { type: "text", value }` (`ToolResultOutput`).
 */

/** What the model sees for a successful call: compact, no SQL and no params. */
export type ModelToolView = {
  data: unknown
  facts: {
    id: string
    metric: string
    value: Fact["value"]
    unit: string
    group: Record<string, string>
  }[]
  notes: string[]
  truncated: boolean
  receipt_id: string
}

/** What the model sees for an expected failure: the hint, never a stack. */
export type ModelToolError = {
  error: { kind: ToolError["code"]; message: string; hint: string }
}

/** A generic sanitized failure for anything unexpected (no DB text, no stack). */
const GENERIC_ERROR: ModelToolError = {
  error: {
    kind: "db_unavailable",
    message: "The tool failed unexpectedly.",
    hint: "Tell the user the tool could not complete; do not cite numbers from it.",
  },
}

/**
 * The tool execute result, before `toModelOutput` compacts it. The full
 * `ToolResult` is carried so the UI tool part can render it; the model view is
 * derived in `toModelOutput`.
 */
export type ToolExecuteResult =
  | { ok: true; result: ToolResult<unknown> }
  | { ok: false; error: ModelToolError }

/** Compact view of one fact for the model. */
function factView(fact: Fact): ModelToolView["facts"][number] {
  return {
    id: fact.id,
    metric: fact.metric,
    value: fact.value,
    unit: fact.unit,
    group: fact.group,
  }
}

/** The compact model view of a successful result (no SQL, no params). */
export function modelView(result: ToolResult<unknown>): ModelToolView {
  return {
    data: result.data,
    facts: result.facts.map(factView),
    notes: result.notes,
    truncated: result.receipt.truncated,
    receipt_id: result.receipt.receipt_id,
  }
}

/** Maps a `ToolError` to the model-facing error value (no stack, no DB text). */
export function toolErrorValue(error: ToolError): ModelToolError {
  return {
    error: { kind: error.code, message: error.message, hint: error.hint },
  }
}

/**
 * Maps a registry `ToolOutcome` to the `ToolExecuteResult` the adapter returns,
 * so the preflight `describe_corpus` path and the tool adapter produce the same
 * UI tool-part shape and map `ToolError` identically (technical.md § 11.1: the
 * UI tool part carries the full result).
 */
export function toExecuteResult(
  outcome:
    { ok: true; result: ToolResult<unknown> } | { ok: false; error: ToolError }
): ToolExecuteResult {
  return outcome.ok
    ? { ok: true, result: outcome.result }
    : { ok: false, error: toolErrorValue(outcome.error) }
}

/**
 * Builds the AI SDK tool set from the registry, in the registry's fixed order.
 * The returned object preserves that key order, so the tool definitions are
 * byte-stable across calls within a run (the cache prefix depends on it,
 * technical.md § 11.1). `callContext` is injected by the caller (the route or
 * runner); the model can never set client, abort or permission profile.
 */
export function buildTools(
  registry: Registry,
  callContext: (signal: AbortSignal) => CallContext
): ToolSet {
  const tools: Record<string, Tool> = {}
  for (const entry of registry.tools) {
    tools[entry.name] = tool({
      description: entry.description,
      inputSchema: entry.inputSchema,
      async execute(input, options): Promise<ToolExecuteResult> {
        // The AbortSignal of the overall operation flows into the registry so a
        // cancelled run cancels the query; a cancelled call rejects, which the
        // SDK surfaces as the operation's abort rather than a tool value.
        const signal = options.abortSignal ?? new AbortController().signal
        try {
          const outcome = await registry.runTool(
            entry.name,
            input,
            callContext(signal)
          )
          // Success carries the full result; an expected failure goes back as a
          // value with the correction hint, never thrown (§ 11.1, § 8.4). The
          // same mapping is reused for the preflight describe_corpus path.
          return toExecuteResult(outcome)
        } catch (error) {
          // A cancellation must propagate so the SDK aborts the step; every
          // other failure (a ToolFailure or anything unexpected) maps to the
          // one generic sanitized value.
          if (signal.aborted) throw error
          return { ok: false, error: GENERIC_ERROR }
        }
      },
      /**
       * The model view: data, compact facts, notes, truncated, receipt_id —
       * no SQL, no params. The UI tool part still receives the full result
       * object above. Expected failures pass through as the `{ error }` value.
       * The result data passed the tool's Zod output schema in the registry,
       * so it is JSON; the cast tells the SDK's `JSONValue` bound that.
       */
      toModelOutput({ output }) {
        const value = output as ToolExecuteResult
        const json = (
          value.ok ? modelView(value.result) : value.error
        ) as JSONValue
        return { type: "json", value: json }
      },
    })
  }
  return tools
}
