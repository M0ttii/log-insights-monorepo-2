import { performance } from "node:perf_hooks"

import {
  fromZodError,
  invalidInput,
  limitExceeded,
  notFound,
  receiptUnavailable,
  type ToolError,
} from "@workspace/domain/errors"
import { buildFacts } from "@workspace/domain/facts"
import {
  canonicalJson,
  receiptSchema,
  RESULT_MAX_BYTES,
  type Client,
  type Receipt,
  type ReceiptSummary,
} from "@workspace/domain/receipt"
import {
  roleGuidanceSchema,
  toolResultSchema,
  type Clock,
  type QueryRunner,
  type ReceiptStore,
  type RoleGuidance,
  type ToolAnnotations,
  type ToolContext,
  type ToolDef,
  type ToolOutcome,
  type ToolResult,
} from "@workspace/domain/tool"
import { z } from "zod"

import { readDataVersion } from "./corpus.ts"
import { QueryFailure, toToolError, type Database } from "./db.ts"
import {
  newReceiptId,
  ReceiptIdTaken,
  receiptSignature,
  resultDigest,
} from "./receipts.ts"
import { checkClaims } from "./tools/check-claims.ts"
import { countEvents } from "./tools/count-events.ts"
import { describeCorpus } from "./tools/describe-corpus.ts"
import { eventTrend } from "./tools/event-trend.ts"
import { getLogContext } from "./tools/get-log-context.ts"
import { searchLogs } from "./tools/search-logs.ts"

/**
 * The tool registry (technical.md § 8): one list of tools and one run
 * pipeline shared by the MCP server, the web app and the eval runner.
 *
 * runTool: schema parse → cross-field check → data version → run() → output
 * check → facts → receipt file → ToolResult. Expected failures come back as
 * `ToolError` values. A cancelled call rejects with the signal's reason and
 * stores no receipt. Any other failure rejects with `ToolFailure`, whose
 * message carries no database text.
 */

/** Per call: who asks, and the signal that cancels the call. */
export type CallContext = {
  client: Client
  signal: AbortSignal
}

/** A tool with its input and output types hidden, so one list holds every tool. */
export type ToolEntry = {
  readonly name: string
  readonly title: string
  readonly version: string
  readonly description: string
  readonly annotations: ToolAnnotations
  /** Strict input schema; MCP and the AI SDK validate against it too. */
  readonly inputSchema: z.ZodType
  /** The whole result envelope (data, facts, receipt, notes), for MCP `outputSchema`. */
  readonly outputSchema: z.ZodType
  execute(rawInput: unknown, run: RunEnvironment): Promise<ToolOutcome<unknown>>
  /**
   * Text block for clients without structured output (MCP, § 9); `null`
   * when the tool defines no summary.
   */
  summarize(result: ToolResult<unknown>): string | null
}

/** Catalog row for MCP (U06), the AI SDK adapter (U15/U17) and the README tool reference (U20). */
export type ToolCatalogEntry = {
  name: string
  title: string
  version: string
  description: string
  annotations: ToolAnnotations
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
}

type RunEnvironment = {
  db: QueryRunner
  receipts: ReceiptStore
  clock: Clock
  roleGuidance: RoleGuidance | undefined
  call: CallContext
  dataVersion(
    signal: AbortSignal
  ): Promise<
    { ok: true; dataVersion: string } | { ok: false; error: ToolError }
  >
  log(line: string): void
}

export type RerunOutcome =
  | {
      ok: true
      original: ReceiptSummary
      result: ToolResult<unknown>
      /** Same signature and data version must give the same digest (§ 6.2, S-12). */
      matches: {
        signature: boolean
        data_version: boolean
        result_digest: boolean
      }
    }
  | { ok: false; error: ToolError }

export type Registry = {
  /** Fixed order, decided once when the registry is created. */
  readonly tools: readonly ToolEntry[]
  catalog(): ToolCatalogEntry[]
  runTool(
    name: string,
    rawInput: unknown,
    call: CallContext
  ): Promise<ToolOutcome<unknown>>
  /** Runs the receipt's tool again with its stored validated input, never its SQL. */
  rerun(receiptId: string, call: CallContext): Promise<RerunOutcome>
}

export type RegistryOptions = {
  db: Pick<Database, "query" | "timeoutMs">
  receipts: ReceiptStore
  clock?: Clock
  /** From `agent/playbooks` (U15); analytics cannot import agent, so callers inject it. */
  roleGuidance?: RoleGuidance
  /** LOG_INSIGHTS_WORKSPACE_TOOLS=1: also register the optional index tools (A-33). */
  workspaceTools?: boolean
  /** One line per call to stderr by default (stdout belongs to MCP). */
  log?: (line: string) => void
  /** Replaces the tool list; for tests of the pipeline. */
  tools?: readonly ToolEntry[]
}

/** A call whose stored receipt would hold a different ID retries with a new one this often. */
const RECEIPT_ID_ATTEMPTS = 3

/** Thrown for failures that are neither expected tool errors nor cancellations. */
export class ToolFailure extends Error {
  constructor(tool: string) {
    super(
      `Tool ${tool} failed unexpectedly; the cause was logged without details.`
    )
    this.name = "ToolFailure"
  }
}

/**
 * Default tools in their fixed order. MCP clients cache `tools/list` best
 * when it never changes (U06). One module per tool keeps parallel tool
 * tickets (U07–U13) apart.
 */
const DEFAULT_TOOLS: readonly ToolEntry[] = [
  toolEntry(describeCorpus),
  toolEntry(searchLogs),
  toolEntry(getLogContext),
  toolEntry(countEvents),
  toolEntry(eventTrend),
  toolEntry(checkClaims),
]

/** Optional index tools (A-33, P2); none implemented yet. */
const WORKSPACE_TOOLS: readonly ToolEntry[] = []

export function createRegistry(options: RegistryOptions): Registry {
  const tools =
    options.tools ??
    (options.workspaceTools === true
      ? [...DEFAULT_TOOLS, ...WORKSPACE_TOOLS]
      : DEFAULT_TOOLS)
  const byName = new Map<string, ToolEntry>()
  for (const tool of tools) {
    if (byName.has(tool.name))
      throw new Error(`duplicate tool name: ${tool.name}`)
    byName.set(tool.name, tool)
  }
  const roleGuidance =
    options.roleGuidance === undefined
      ? undefined
      : roleGuidanceSchema.parse(options.roleGuidance)
  const clock = options.clock ?? { now: () => new Date().toISOString() }
  const log =
    options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const { db, receipts } = options

  // Read lazily and kept for the process; a reload needs a restart (§ 6.1).
  let dataVersion: string | null = null
  const readVersion: RunEnvironment["dataVersion"] = async (signal) => {
    if (dataVersion !== null) return { ok: true, dataVersion }
    const read = await readDataVersion(db, signal)
    if (read.ok) dataVersion = read.dataVersion
    return read
  }

  const runTool: Registry["runTool"] = async (name, rawInput, call) => {
    const started = performance.now()
    const entry = byName.get(name)
    // Unknown names come from the client; they never reach the log verbatim.
    const tool = entry === undefined ? "unknown" : name
    let outcome: ToolOutcome<unknown>
    try {
      if (entry === undefined) {
        outcome = {
          ok: false,
          error: invalidInput(
            [{ path: "", message: `Unknown tool: ${name}.` }],
            `Use one of: ${[...byName.keys()].join(", ")}.`
          ),
        }
      } else {
        call.signal.throwIfAborted()
        outcome = await entry.execute(rawInput, {
          db,
          receipts,
          clock,
          roleGuidance,
          call,
          dataVersion: readVersion,
          log,
        })
      }
    } catch (error) {
      const elapsed = elapsedMs(started)
      if (call.signal.aborted) {
        log(opsLine(tool, call.client, elapsed, null, "cancelled"))
        throw call.signal.reason
      }
      const mapped =
        error instanceof QueryFailure ? toToolError(error, db.timeoutMs) : null
      if (mapped === null) {
        log(
          opsLine(
            tool,
            call.client,
            elapsed,
            null,
            `failed ${failureKind(error)}`
          )
        )
        throw new ToolFailure(name)
      }
      outcome = { ok: false, error: mapped }
    }
    const bytes = outcome.ok
      ? Buffer.byteLength(canonicalJson(outcome.result.data))
      : null
    log(
      opsLine(
        tool,
        call.client,
        elapsedMs(started),
        bytes,
        outcome.ok ? "ok" : `error=${outcome.error.code}`
      )
    )
    return outcome
  }

  return {
    tools,
    catalog: () =>
      tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        version: tool.version,
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: z.toJSONSchema(tool.inputSchema),
        outputSchema: z.toJSONSchema(tool.outputSchema),
      })),
    runTool,
    async rerun(receiptId, call) {
      const original = await receipts.get(receiptId)
      if (original === null)
        return { ok: false, error: notFound("receipt", receiptId) }
      const outcome = await runTool(original.tool, original.input, call)
      if (!outcome.ok) return outcome
      const { receipt } = outcome.result
      return {
        ok: true,
        original: summarize(original),
        result: outcome.result,
        matches: {
          signature: receipt.signature === original.signature,
          data_version: receipt.data_version === original.data_version,
          result_digest: receipt.result_digest === original.result_digest,
        },
      }
    },
  }
}

/** Binds a definition to the pipeline; its types stay inside the closure. */
export function toolEntry<I, O>(def: ToolDef<I, O>): ToolEntry {
  const accepted =
    def.input instanceof z.ZodObject ? Object.keys(def.input.shape) : undefined
  return {
    name: def.name,
    title: def.title,
    version: def.version,
    description: def.description,
    annotations: def.annotations,
    inputSchema: def.input,
    outputSchema: toolResultSchema(def.output),
    async execute(rawInput, environment) {
      const parsed = def.input.safeParse(rawInput)
      if (!parsed.success)
        return { ok: false, error: fromZodError(parsed.error, accepted) }
      const invalid = def.validate?.(parsed.data) ?? null
      if (invalid !== null) return { ok: false, error: invalid }
      return runDefinition(def, parsed.data, environment)
    },
    summarize(result) {
      if (def.summary === undefined) return null
      // The data passed the output schema when the result was built.
      return def.summary({ ...result, data: def.output.parse(result.data) })
    },
  }
}

async function runDefinition<I, O>(
  def: ToolDef<I, O>,
  input: I,
  environment: RunEnvironment
): Promise<ToolOutcome<O>> {
  const { call, clock, receipts } = environment
  const version = await environment.dataVersion(call.signal)
  if (!version.ok) return version

  // Every query of the run is recorded in execution order for the receipt.
  const sql: string[] = []
  const params: unknown[][] = []
  let durationMs = 0
  const recorder: QueryRunner = {
    async query(text, values, signal) {
      const result = await environment.db.query(text, values, signal)
      sql.push(text)
      params.push([...values])
      durationMs += result.durationMs
      return result
    },
  }
  const ctx: ToolContext = {
    db: recorder,
    clock,
    receipts,
    dataVersion: version.dataVersion,
    client: call.client,
    signal: call.signal,
    ...(environment.roleGuidance === undefined
      ? {}
      : { roleGuidance: environment.roleGuidance }),
  }

  const outcome = await def.run(ctx, input)
  if (!outcome.ok) return outcome
  // A cancelled call returns nothing and stores no receipt.
  call.signal.throwIfAborted()

  const { run } = outcome
  const data = def.output.parse(run.data)
  const resultBytes = Buffer.byteLength(canonicalJson(data))
  if (resultBytes > RESULT_MAX_BYTES) {
    return {
      ok: false,
      error: limitExceeded(
        "Result size in bytes",
        RESULT_MAX_BYTES,
        resultBytes
      ),
    }
  }

  const signature = receiptSignature(def.name, def.version, input)
  const digest = resultDigest(data)
  const factSpecs =
    typeof def.factSpecs === "function" ? def.factSpecs(input) : def.factSpecs
  for (let attempt = 0; attempt < RECEIPT_ID_ATTEMPTS; attempt++) {
    const receiptId = newReceiptId()
    const facts = buildFacts(
      receiptId,
      { result: data, scope: run.scope },
      factSpecs
    )
    const receipt = receiptSchema.parse({
      receipt_id: receiptId,
      created_at: clock.now(),
      client: call.client,
      tool: def.name,
      tool_version: def.version,
      input,
      signature,
      data_version: version.dataVersion,
      sql,
      params,
      scope: run.scope,
      population: run.population,
      rows_returned: run.rows_returned,
      truncated: run.truncated,
      row_limit: run.row_limit,
      duration_ms: Math.round(durationMs * 100) / 100,
      result: data,
      result_digest: digest,
      facts,
    })
    try {
      await receipts.put(receipt)
    } catch (error) {
      if (error instanceof ReceiptIdTaken) continue
      environment.log(
        `receipt write failed tool=${def.name} ${failureKind(error)}`
      )
      return { ok: false, error: receiptUnavailable() }
    }
    return {
      ok: true,
      result: { data, facts, receipt: summarize(receipt), notes: run.notes },
    }
  }
  return { ok: false, error: receiptUnavailable() }
}

function summarize(receipt: Receipt): ReceiptSummary {
  return {
    receipt_id: receipt.receipt_id,
    input: receipt.input,
    signature: receipt.signature,
    data_version: receipt.data_version,
    sql: receipt.sql,
    params: receipt.params,
    scope: receipt.scope,
    population: receipt.population,
    rows_returned: receipt.rows_returned,
    truncated: receipt.truncated,
    duration_ms: receipt.duration_ms,
    result_digest: receipt.result_digest,
  }
}

/** Tool, client, duration, result size and outcome; never input values, SQL or log text (§ 12). */
function opsLine(
  tool: string,
  client: Client,
  durationMs: number,
  resultBytes: number | null,
  outcome: string
): string {
  return `tool=${tool} client=${client} duration_ms=${durationMs} result_bytes=${resultBytes ?? "-"} outcome=${outcome}`
}

function elapsedMs(started: number): number {
  return Math.round(performance.now() - started)
}

function failureKind(error: unknown): string {
  if (error instanceof QueryFailure)
    return `kind=${error.kind}${error.sqlstate === null ? "" : ` sqlstate=${error.sqlstate}`}`
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  )
    return `code=${error.code}`
  return `kind=${error instanceof Error ? error.name : typeof error}`
}
