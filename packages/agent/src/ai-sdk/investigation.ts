import type { CallContext, Registry } from "@workspace/analytics/registry"
import {
  answerFindings,
  detectSections,
  findingsFeedback,
  gateFindingSchema,
  type AnswerRole,
  type GateFinding,
  type SubmittedCheck,
} from "@workspace/domain/answer"
import type { Fact } from "@workspace/domain/facts"
import { filterSchema } from "@workspace/domain/filters"
import {
  checkClaimsOutputSchema,
  type CheckClaimsOutput,
} from "@workspace/domain/tools/check-claims"
import { CONTRACT_VERSION } from "@workspace/domain/version"
import {
  convertToModelMessages,
  createUIMessageStream,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type StopCondition,
  type StreamTextResult,
  type SystemModelMessage,
  type ToolSet,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai"
import { z } from "zod"

import {
  BASELINE_INSTRUCTIONS,
  baselineRoleInstruction,
  type BaselineRole,
} from "./baseline.ts"
import {
  claimsHint,
  coverageHint,
  missingCoverage,
  type CoverageStep,
  type RoleCoverage,
} from "./coverage.ts"
import type { ModelConfig } from "./model.ts"
import {
  newRunId,
  runRecordSchema,
  type RunPhase,
  type RunRecord,
  type RunStatus,
  type RunStep,
  type RunStore,
  type RunUsage,
} from "./run-record.ts"
import { buildTools } from "./tools.ts"

/**
 * The phase machine `runInvestigation` (technical.md § 11.1, U17): one AI SDK
 * UI message stream, one model call per model phase. `preflight` runs
 * `describe_corpus` in code; `investigate`, `answer` and `revise` call the
 * model and merge their stream through `writer.merge`. The conversation is
 * append-only; the top-level system prompt and the tool set are byte-identical
 * across every call of a run, so Claude's cache prefix holds (§ 11.1). Phase
 * hints, coverage follow-ups and the revision feedback go in as `role:"system"`
 * entries inside `messages` (the operator channel log text cannot imitate),
 * enabled with `allowSystemInMessages: true`.
 *
 * The AI SDK is read through the pieces the previous stage pinned: the model
 * and provider options from `model.ts`, the registry → tool adapter from
 * `tools.ts`, the coverage helpers from `coverage.ts`, the run record from
 * `run-record.ts`, and the deterministic gate from `@workspace/domain/answer`.
 */

/** The maximum question length (bounded input, § 11.1). */
const QUESTION_MAX = 4000

/** The exact `providerOptions` type `streamText` accepts (SDK JSON record). */
type StreamTextProviderOptions = NonNullable<
  Parameters<typeof streamText>[0]["providerOptions"]
>

export const investigationRoleSchema = z.enum([
  "engineer",
  "team_lead",
  "manager",
  "auto",
])
export type InvestigationRole = z.infer<typeof investigationRoleSchema>

export const investigationVariantSchema = z.enum(["playbook", "baseline"])
export type InvestigationVariant = z.infer<typeof investigationVariantSchema>

/**
 * Structured scope on the shared filter schema from domain: `dataset`, `from`,
 * `to` and the remaining `filters`. Scope is handed to the model only as a
 * stated default in the first user message; it is never a tool call, so the
 * model may narrow or widen it with real tool inputs.
 */
export const investigationScopeSchema = filterSchema
  .pick({ dataset: true, from: true, to: true })
  .extend({
    filters: filterSchema
      .omit({ dataset: true, from: true, to: true })
      .optional()
      .describe("Further filters stated as the default scope."),
  })
export type InvestigationScope = z.infer<typeof investigationScopeSchema>

/** A prior UI message, passed through unchanged (append-only history). */
const historyMessageSchema: z.ZodType<UIMessage> = z.custom<UIMessage>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    "parts" in value
)

export const investigationInputSchema = z.strictObject({
  question: z.string().min(1).max(QUESTION_MAX),
  role: investigationRoleSchema,
  scope: investigationScopeSchema.optional(),
  history: z.array(historyMessageSchema).optional(),
  variant: investigationVariantSchema.default("playbook"),
})

export type InvestigationInput = z.input<typeof investigationInputSchema>
type ParsedInput = z.output<typeof investigationInputSchema>

/** The loaded playbooks plus the optional LOG-47 coverage data (absent today). */
export type InvestigationPlaybooks = {
  version: string
  instructions: string
  systemPrompt: (role: AnswerRole) => string
  /**
   * LOG-47 (not merged): per-role required evidence. When absent, only
   * `mismatch`/`unresolved` in the last check_claims trigger a follow-up —
   * there is no coverage requirement to miss.
   */
  coverage?: Partial<Record<AnswerRole, RoleCoverage>>
}

/** Configurable limits; the defaults were fixed by the eval (§ 11.1). */
export type InvestigationLimits = {
  maxSteps: number
  maxFollowUps: number
  maxRevisions: number
  timeoutMs: number
}

export const DEFAULT_LIMITS: InvestigationLimits = {
  maxSteps: 16,
  maxFollowUps: 2,
  maxRevisions: 1,
  timeoutMs: 180_000,
}

export type InvestigationDeps = {
  registry: Registry
  playbooks: InvestigationPlaybooks
  runs: RunStore
  model: ModelConfig
  callContext: (signal: AbortSignal) => CallContext
  limits?: Partial<InvestigationLimits>
  /** Injectable clock for the run record timestamps (tests). */
  now?: () => Date
}

/** Typed data parts of the UI message stream (ui-concept § 12). */
type PhaseBoundary = {
  kind: "preflight" | "investigate" | "answer" | "revise"
  draft: "draft" | "final"
}
type InvestigationDataParts = {
  phase: PhaseBoundary
  gate: { version: "draft" | "final"; findings: GateFinding[] }
  run: {
    run_id: string
    status: RunStatus
    duration_ms: number
    usage: RunUsage
  }
}

/** The UI message type this stream produces: typed data parts, generic tools. */
export type InvestigationUIMessage = UIMessage<
  never,
  InvestigationDataParts,
  Record<string, never>
>

type Writer = UIMessageStreamWriter<InvestigationUIMessage>

export type InvestigationResult = {
  stream: ReadableStream<unknown>
  done: Promise<RunRecord>
}

/** A phase's exact prompt, captured for the append-only / identical assertions. */
export type PhasePrompt = {
  system: string
  messages: ModelMessage[]
}

/**
 * Runs an investigation. Returns the UI message stream immediately and a
 * `done` promise that resolves with the written RunRecord. Validation errors
 * reject the whole call (the route maps them to 400); everything after the
 * model starts is captured in the record, so a stopped, timed-out, refused or
 * errored run still resolves `done` with its record.
 */
export function runInvestigation(
  rawInput: InvestigationInput,
  deps: InvestigationDeps,
  signal: AbortSignal
): InvestigationResult {
  const input = investigationInputSchema.parse(rawInput)
  const limits: InvestigationLimits = { ...DEFAULT_LIMITS, ...deps.limits }
  const now = deps.now ?? (() => new Date())
  return new PhaseMachine(input, deps, limits, signal, now).run()
}

/** One model phase's outcome, read once its model call ends. */
type ModelPhaseOutcome = {
  finishReason: string
  responseMessages: ModelMessage[]
  steps: { toolName: string; input: unknown; output: unknown }[]
  usage: RunUsage
  aborted: boolean
  errored: boolean
}

type PhaseKind = "investigate" | "answer" | "revise"

class PhaseMachine {
  private readonly runId = newRunId()
  private readonly startedAt: Date

  /** Combined abort: the caller's signal OR the 180 s timeout. */
  private readonly controller = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
  private timedOut = false

  /** The byte-stable system prompt and tool set, built once. */
  private readonly system: string
  private readonly tools: ToolSet

  /** The append-only conversation. Each phase extends this; never rewritten. */
  private readonly messages: ModelMessage[] = []
  private previousPrompt: PhasePrompt | null = null
  /** Captured prompts, in phase order, for tests (append-only + identical). */
  readonly prompts: PhasePrompt[] = []

  private readonly phases: RunPhase[] = []
  private readonly checks: SubmittedCheck[] = []
  private readonly coverageSteps: CoverageStep[] = []
  private readonly coverageRequests: string[] = []
  private readonly gateFindingsPerDraft: GateFinding[][] = []

  private stepsUsed = 0
  private readonly usageTotal: RunUsage = {
    input: null,
    output: null,
    cache_read: null,
    cache_write: null,
  }

  private status: RunStatus = "completed"
  private errorKind: string | null = null
  private finalText: string | null = null

  constructor(
    private readonly input: ParsedInput,
    private readonly deps: InvestigationDeps,
    private readonly limits: InvestigationLimits,
    signal: AbortSignal,
    private readonly now: () => Date
  ) {
    this.startedAt = now()

    // Combine the caller's signal with the run's own timeout: either aborts
    // the model and the tools. A pre-aborted caller signal aborts at once.
    if (signal.aborted) this.controller.abort(signal.reason)
    else
      signal.addEventListener(
        "abort",
        () => this.controller.abort(signal.reason),
        { once: true }
      )
    this.timer = setTimeout(() => {
      this.timedOut = true
      this.controller.abort(new Error("investigation timeout"))
    }, limits.timeoutMs)
    this.timer.unref?.()

    this.system = buildSystem(input, deps.playbooks)
    this.tools = buildTools(deps.registry, deps.callContext)
  }

  run(): InvestigationResult {
    const gate = deferred<RunRecord>()

    const stream = createUIMessageStream<InvestigationUIMessage>({
      execute: async ({ writer }) => {
        try {
          await this.execute(writer)
        } finally {
          clearTimeout(this.timer)
          const record = this.buildRecord()
          await this.deps.runs.put(record).catch(() => undefined)
          this.emitFinalize(writer, record)
          gate.resolve(record)
        }
      },
      onError: () => "An error occurred during the investigation.",
    }) as unknown as ReadableStream<unknown>

    return { stream, done: gate.promise }
  }

  /** The whole phase sequence; failures set the status and are swallowed here. */
  private async execute(writer: Writer): Promise<void> {
    try {
      await this.preflight(writer)
      await this.investigateWithCoverage(writer)
      const draft = await this.answerPhase(writer)
      const draftFindings = this.gate(writer, draft, "draft")
      if (draftFindings.length > 0 && this.limits.maxRevisions > 0) {
        const revised = await this.revisePhase(writer, draftFindings)
        this.gate(writer, revised, "final")
      }
    } catch (error) {
      this.classifyFailure(error)
    }
  }

  // --- preflight ----------------------------------------------------------

  private async preflight(writer: Writer): Promise<void> {
    this.throwIfAborted()
    writer.write({
      type: "data-phase",
      data: { kind: "preflight", draft: "draft" },
    })

    // Prior UI history is passed through unchanged as the conversation prefix.
    if (this.input.history !== undefined && this.input.history.length > 0)
      this.messages.push(...(await convertToModelMessages(this.input.history)))

    // describe_corpus runs in code through the registry: Opus 5.5 rejects a
    // forced tool choice, but the entry after common.md is mandatory (§ 11.1).
    const call = this.deps.callContext(this.controller.signal)
    const outcome = await this.deps.registry.runTool(
      "describe_corpus",
      {},
      call
    )
    const toolCallId = `preflight_describe_corpus_${this.runId}`

    writer.write({
      type: "tool-input-available",
      toolCallId,
      toolName: "describe_corpus",
      input: {},
    })

    let contextLine: string
    if (outcome.ok) {
      const { data, facts, receipt } = outcome.result
      writer.write({
        type: "tool-output-available",
        toolCallId,
        output: {
          facts: facts.map(compactFact),
          receipt_id: receipt.receipt_id,
          truncated: receipt.truncated,
        },
      })
      this.recordStep("preflight", {
        tool: "describe_corpus",
        input: {},
        receipt_id: receipt.receipt_id,
        duration_ms: receipt.duration_ms,
        error_kind: null,
      })
      this.coverageSteps.push({ tool: "describe_corpus", input: {}, ok: true })
      contextLine = describeCorpusContext(data, facts)
    } else {
      writer.write({
        type: "tool-output-available",
        toolCallId,
        output: { error: outcome.error.code },
      })
      this.recordStep("preflight", {
        tool: "describe_corpus",
        input: {},
        receipt_id: null,
        duration_ms: 0,
        error_kind: outcome.error.code,
      })
      this.coverageSteps.push({ tool: "describe_corpus", input: {}, ok: false })
      contextLine = `describe_corpus could not run (${outcome.error.code}): ${outcome.error.hint}`
    }

    this.messages.push({
      role: "user",
      content: firstUserMessage(this.input, contextLine),
    })
  }

  // --- investigate + coverage --------------------------------------------

  private async investigateWithCoverage(writer: Writer): Promise<void> {
    let followUps = 0
    for (;;) {
      await this.runInvestigatePhase(writer)
      if (this.budgetExhausted()) return

      const hint = this.coverageFollowUp()
      if (hint === null || followUps >= this.limits.maxFollowUps) return
      followUps += 1
      this.coverageRequests.push(hint)
      this.pushSystem(hint)
    }
  }

  private async runInvestigatePhase(writer: Writer): Promise<void> {
    writer.write({
      type: "data-phase",
      data: { kind: "investigate", draft: "draft" },
    })
    await this.runModelPhase(writer, "investigate")
  }

  /**
   * The deterministic coverage follow-up hint, or null when none is due.
   *
   * Coverage requirements are playbook-only (§ 13.2 "gemeinsame Grundlage":
   * gate and the one revision are shared, coverage is playbook content). The
   * `mismatch`/`unresolved` follow-up is decided below.
   */
  private coverageFollowUp(): string | null {
    if (this.input.variant === "baseline") {
      // Documented choice (§ 13.2): the baseline shares the gate and the one
      // revision but NOT the coverage follow-up. The follow-up round (fetch
      // missing evidence, re-check claims, then re-investigate) is part of the
      // playbook role-guidance the comparison is meant to measure, so giving it
      // to the baseline would blur the very thing under test and spend extra
      // steps. The baseline's mismatch/unresolved are still surfaced by the
      // shared gate and fixed in the one shared revision — so nothing is lost,
      // only the extra corrective loop is withheld.
      return null
    }
    const coverage = this.roleCoverage()
    const missing =
      coverage === null ? [] : missingCoverage(coverage, this.coverageSteps)
    const parts = [coverageHint(missing), claimsHint(lastCheck(this.checks))]
    const present = parts.filter((part): part is string => part !== null)
    return present.length === 0 ? null : present.join(" ")
  }

  private roleCoverage(): RoleCoverage | null {
    const role = this.resolvedAnswerRole()
    if (role === null) return null
    return this.deps.playbooks.coverage?.[role] ?? null
  }

  // --- answer -------------------------------------------------------------

  private async answerPhase(writer: Writer): Promise<string> {
    writer.write({
      type: "data-phase",
      data: { kind: "answer", draft: "draft" },
    })
    this.pushSystem(
      "Write the final answer now in the role format; cite only checked facts."
    )
    await this.runModelPhase(writer, "answer")
    this.finalText = lastAssistantText(this.messages)
    return this.finalText ?? ""
  }

  // --- gate ---------------------------------------------------------------

  private gate(
    writer: Writer,
    text: string,
    version: "draft" | "final"
  ): GateFinding[] {
    const findings = answerFindings({
      text,
      role: this.resolvedAnswerRole(),
      checks: this.checks,
    })
    this.gateFindingsPerDraft.push(findings)
    writer.write({ type: "data-gate", data: { version, findings } })
    return findings
  }

  // --- revise -------------------------------------------------------------

  private async revisePhase(
    writer: Writer,
    findings: GateFinding[]
  ): Promise<string> {
    writer.write({
      type: "data-phase",
      data: { kind: "revise", draft: "final" },
    })
    this.pushSystem(
      `${findingsFeedback(findings)}\nRe-check every number you changed with check_claims, then rewrite the whole answer in the role format.`
    )
    await this.runModelPhase(writer, "revise")
    this.finalText = lastAssistantText(this.messages) ?? this.finalText
    return this.finalText ?? ""
  }

  // --- finalize -----------------------------------------------------------

  private emitFinalize(writer: Writer, record: RunRecord): void {
    writer.write({
      type: "data-run",
      data: {
        run_id: record.run_id,
        status: record.status,
        duration_ms: record.duration_ms,
        usage: record.usage,
      },
    })
  }

  // --- model phase --------------------------------------------------------

  /**
   * One model call: streams into the writer via `writer.merge`, appends the
   * model's response messages to the conversation (append-only) and records the
   * tool steps. The system prompt and tool set are passed identically every
   * time; phase hints already live in `messages` as `role:"system"` entries.
   */
  private async runModelPhase(writer: Writer, kind: PhaseKind): Promise<void> {
    this.throwIfAborted()
    const remaining = Math.max(1, this.limits.maxSteps - this.stepsUsed)

    const prompt: PhasePrompt = {
      system: this.system,
      messages: this.messages.map(cloneMessage),
    }
    this.assertPrefixExtension(prompt)
    this.prompts.push(prompt)
    this.previousPrompt = prompt

    const result = streamText({
      model: this.deps.model.model as LanguageModel,
      system: this.system,
      messages: this.messages,
      tools: this.tools,
      allowSystemInMessages: true,
      // The provider options are the typed Anthropic options from model.ts.
      // streamText types `providerOptions` as a plain JSON record; the typed
      // Anthropic options (e.g. `fallbacks`) are a structural superset of JSON,
      // so this one localized cast bridges the two without widening model.ts.
      providerOptions: this.deps.model
        .providerOptions as StreamTextProviderOptions,
      abortSignal: this.controller.signal,
      stopWhen: stopCondition(remaining),
    }) as StreamTextResult<ToolSet, never, never>

    writer.merge(
      result.toUIMessageStream<InvestigationUIMessage>({ sendStart: false })
    )

    const outcome = await this.readPhase(result)
    this.messages.push(...outcome.responseMessages)
    this.recordOutcome(kind, outcome)

    if (outcome.aborted) this.throwIfAborted()
    if (outcome.errored) {
      this.status = "error"
      this.errorKind = "model_error"
    }
    if (outcome.finishReason === "content-filter") this.status = "refusal"
  }

  /** Reads the finished model phase; an abort surfaces as `aborted`, not a throw. */
  private async readPhase(
    result: StreamTextResult<ToolSet, never, never>
  ): Promise<ModelPhaseOutcome> {
    try {
      const [steps, usage, finishReason, responseMessages] = await Promise.all([
        result.steps,
        result.usage,
        result.finishReason,
        result.responseMessages,
      ])
      return {
        finishReason,
        responseMessages: responseMessages as ModelMessage[],
        steps: flattenToolResults(steps),
        usage: mapUsage(usage),
        aborted: this.controller.signal.aborted,
        errored: false,
      }
    } catch {
      if (this.controller.signal.aborted) return emptyOutcome(true, false)
      return emptyOutcome(false, true)
    }
  }

  private recordOutcome(kind: PhaseKind, outcome: ModelPhaseOutcome): void {
    addUsage(this.usageTotal, outcome.usage)
    this.stepsUsed += Math.max(1, outcome.steps.length)
    for (const step of outcome.steps) {
      const view = stepView(step.output)
      this.recordStep(kind, {
        tool: step.toolName,
        input: step.input as RunStep["input"],
        receipt_id: view.receiptId,
        duration_ms: 0,
        error_kind: view.errorKind,
      })
      this.coverageSteps.push({
        tool: step.toolName,
        input: step.input,
        ok: view.errorKind === null,
      })
      if (step.toolName === "check_claims" && view.checkOutput !== null) {
        this.checks.push({
          receipt_id: view.receiptId ?? "",
          output: view.checkOutput,
        })
      }
    }
  }

  // --- record assembly ----------------------------------------------------

  private buildRecord(): RunRecord {
    const finishedAt = this.now()
    if (this.timedOut) this.status = "timeout"
    else if (this.controller.signal.aborted && this.status === "completed")
      this.status = "stopped"

    const stoppedOrTimedOut =
      this.status === "stopped" || this.status === "timeout"

    const record: RunRecord = {
      run_id: this.runId,
      started_at: this.startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: Math.max(0, finishedAt.getTime() - this.startedAt.getTime()),
      status: this.status,
      variant: this.input.variant,
      role: { requested: this.input.role, effective: this.effectiveRole() },
      question: this.input.question,
      scope: this.input.scope ?? null,
      model_id: this.deps.model.modelId,
      effort: this.deps.model.effort,
      guidance_version: this.deps.playbooks.version,
      contract_version: CONTRACT_VERSION,
      data_version: null,
      instruction_texts: this.instructionTexts(),
      phases: this.phases,
      coverage_requests: this.coverageRequests,
      gate_findings: this.gateFindingsPerDraft.map((findings) =>
        findings.map((finding) => gateFindingSchema.parse(finding))
      ),
      usage: this.usageTotal,
      final_text: stoppedOrTimedOut ? null : this.finalText,
      check_claims: this.checks.map((check) => ({
        receipt_id: check.receipt_id,
        summary: check.output.summary,
      })),
      error_kind: this.errorKind,
    }
    return runRecordSchema.parse(record)
  }

  /** The role the run used; for `auto`, the detected role or the request. */
  private effectiveRole(): InvestigationRole {
    if (this.input.role !== "auto") return this.input.role
    return detectAutoRole(this.finalText) ?? "auto"
  }

  private instructionTexts(): string[] {
    if (this.input.variant === "baseline") {
      return [
        BASELINE_INSTRUCTIONS.sharedRules,
        baselineRoleInstruction(this.input.role),
      ]
    }
    return [this.system]
  }

  // --- helpers ------------------------------------------------------------

  private recordStep(kind: RunPhase["kind"], step: RunStep): void {
    const last = this.phases.at(-1)
    if (last !== undefined && last.kind === kind) last.steps.push(step)
    else this.phases.push({ kind, steps: [step] })
  }

  private pushSystem(text: string): void {
    const message: SystemModelMessage = { role: "system", content: text }
    this.messages.push(message)
  }

  private budgetExhausted(): boolean {
    return this.stepsUsed >= this.limits.maxSteps
  }

  private resolvedAnswerRole(): AnswerRole | null {
    if (this.input.role !== "auto") return this.input.role
    // Auto: the role the model chose, inferred from the final answer's
    // best-matching core sections (documented choice). Null until the answer
    // exists, and null on an ambiguous tie.
    return detectAutoRole(this.finalText)
  }

  private throwIfAborted(): void {
    if (this.controller.signal.aborted)
      throw this.controller.signal.reason ?? new Error("aborted")
  }

  private classifyFailure(error: unknown): void {
    if (this.timedOut) {
      this.status = "timeout"
      return
    }
    if (this.controller.signal.aborted) {
      this.status = "stopped"
      return
    }
    this.status = "error"
    this.errorKind = error instanceof Error ? error.name || "error" : "error"
  }

  /** Asserts the new prompt is a prefix-extension of the previous phase's. */
  private assertPrefixExtension(next: PhasePrompt): void {
    const prev = this.previousPrompt
    if (prev === null) return
    if (prev.system !== next.system)
      throw new Error("phase system prompt changed across phases")
    if (next.messages.length < prev.messages.length)
      throw new Error("phase history shrank; history must be append-only")
    for (let i = 0; i < prev.messages.length; i += 1) {
      if (JSON.stringify(prev.messages[i]) !== JSON.stringify(next.messages[i]))
        throw new Error(`phase history message ${i} changed; append-only`)
    }
  }
}

// --- free helpers ---------------------------------------------------------

/** The byte-stable system prompt for a variant+role (§ 11.1 "Instruktionen"). */
function buildSystem(
  input: ParsedInput,
  playbooks: InvestigationPlaybooks
): string {
  if (input.variant === "baseline") {
    return `${BASELINE_INSTRUCTIONS.sharedRules}\n\n${baselineRoleInstruction(
      input.role as BaselineRole
    )}`
  }
  if (input.role === "auto") return playbooks.instructions
  return playbooks.systemPrompt(input.role)
}

/** The first user message: scope default, the describe_corpus context, question. */
function firstUserMessage(input: ParsedInput, contextLine: string): string {
  const scope =
    input.scope === undefined
      ? "Scope default: none stated; use the full data span unless the question narrows it."
      : `Scope default (stated, not a tool call): ${JSON.stringify(input.scope)}`
  return [
    `Question: ${input.question}`,
    scope,
    `Corpus context (from describe_corpus, cite these fact IDs): ${contextLine}`,
  ].join("\n\n")
}

function compactFact(fact: Fact): {
  id: string
  metric: string
  value: Fact["value"]
  unit: string
  group: Record<string, string>
} {
  return {
    id: fact.id,
    metric: fact.metric,
    value: fact.value,
    unit: fact.unit,
    group: fact.group,
  }
}

/** A compact one-line context from describe_corpus incl. fact IDs. */
function describeCorpusContext(data: unknown, facts: readonly Fact[]): string {
  const ids = facts
    .slice(0, 12)
    .map((fact) => `${fact.metric}=${String(fact.value)} [${fact.id}]`)
    .join(", ")
  const datasets =
    typeof data === "object" && data !== null && "datasets" in data
      ? JSON.stringify((data as { datasets: unknown }).datasets).slice(0, 2000)
      : ""
  return `${ids}. datasets=${datasets}`
}

/** Stops a phase after check_claims has run anywhere in its steps. */
const STOP_AFTER_CHECK_CLAIMS: StopCondition<ToolSet> = ({ steps }) =>
  steps.some((step) =>
    step.toolCalls.some((call) => call.toolName === "check_claims")
  )

/** Stop after check_claims has run, or at the remaining step cap for this phase. */
function stopCondition(remainingSteps: number): StopCondition<ToolSet>[] {
  const stepCap: StopCondition<ToolSet> = ({ steps }) =>
    steps.length >= remainingSteps
  return [STOP_AFTER_CHECK_CLAIMS, stepCap]
}

/** Flattens the SDK steps into tool (name, input, output) triples in order. */
function flattenToolResults(
  steps: readonly {
    toolResults: readonly {
      toolName: string
      input: unknown
      output: unknown
    }[]
  }[]
): { toolName: string; input: unknown; output: unknown }[] {
  const out: { toolName: string; input: unknown; output: unknown }[] = []
  for (const step of steps) {
    for (const result of step.toolResults) {
      out.push({
        toolName: result.toolName,
        input: result.input,
        output: result.output,
      })
    }
  }
  return out
}

type StepView = {
  receiptId: string | null
  errorKind: string | null
  checkOutput: CheckClaimsOutput | null
}

/**
 * Reads the adapter's tool output into a compact view. The adapter's model
 * output is `{ data, facts, receipt_id }` on success or `{ error: {...} }` on an
 * expected failure (tools.ts `toModelOutput`). The raw `ToolExecuteResult`
 * (`{ ok, result | error }`) is also handled, so the reader works whether the
 * SDK hands back the model view or the execute value.
 */
function stepView(output: unknown): StepView {
  if (typeof output !== "object" || output === null) return empty()
  const record = output as Record<string, unknown>

  if (record.ok === false)
    return {
      receiptId: null,
      errorKind: readErrorKind(
        (record.error as Record<string, unknown>)?.error
      ),
      checkOutput: null,
    }
  if (record.ok === true) {
    const result = record.result as {
      receipt?: { receipt_id?: string }
      data?: unknown
    }
    return {
      receiptId: result.receipt?.receipt_id ?? null,
      errorKind: null,
      checkOutput: parseCheck(result.data),
    }
  }
  if ("error" in record)
    return {
      receiptId: null,
      errorKind: readErrorKind(record.error),
      checkOutput: null,
    }

  return {
    receiptId: typeof record.receipt_id === "string" ? record.receipt_id : null,
    errorKind: null,
    checkOutput: parseCheck(record.data),
  }
}

function empty(): StepView {
  return { receiptId: null, errorKind: null, checkOutput: null }
}

function readErrorKind(error: unknown): string {
  if (typeof error === "object" && error !== null && "kind" in error) {
    const kind = (error as { kind: unknown }).kind
    if (typeof kind === "string") return kind
  }
  return "error"
}

function parseCheck(data: unknown): CheckClaimsOutput | null {
  const parsed = checkClaimsOutputSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

function lastCheck(
  checks: readonly SubmittedCheck[]
): CheckClaimsOutput | null {
  return checks.at(-1)?.output ?? null
}

/** Maps the SDK usage to the run record's nullable token fields. */
function mapUsage(usage: {
  inputTokens?: number
  outputTokens?: number
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
}): RunUsage {
  return {
    input: usage.inputTokens ?? null,
    output: usage.outputTokens ?? null,
    cache_read: usage.inputTokenDetails?.cacheReadTokens ?? null,
    cache_write: usage.inputTokenDetails?.cacheWriteTokens ?? null,
  }
}

function addUsage(total: RunUsage, add: RunUsage): void {
  total.input = sumNullable(total.input, add.input)
  total.output = sumNullable(total.output, add.output)
  total.cache_read = sumNullable(total.cache_read, add.cache_read)
  total.cache_write = sumNullable(total.cache_write, add.cache_write)
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return a + b
}

function emptyOutcome(aborted: boolean, errored: boolean): ModelPhaseOutcome {
  return {
    finishReason: aborted ? "other" : "error",
    responseMessages: [],
    steps: [],
    usage: { input: null, output: null, cache_read: null, cache_write: null },
    aborted,
    errored,
  }
}

/** The concatenated text of the last assistant message in the conversation. */
function lastAssistantText(messages: readonly ModelMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message === undefined || message.role !== "assistant") continue
    if (typeof message.content === "string") return message.content
    return message.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" && part.type === "text"
      )
      .map((part) => part.text)
      .join("")
  }
  return null
}

/**
 * The role the model chose, inferred from the answer's best-matching role core
 * (documented choice for `role: auto`). The role whose core sections appear
 * most wins; zero matches or a tie between equal non-zero counts is ambiguous
 * and returns null (the gate then checks the frame only).
 */
function detectAutoRole(text: string | null): AnswerRole | null {
  if (text === null || text === "") return null
  const roles: AnswerRole[] = ["engineer", "team_lead", "manager"]
  const frame = new Set(detectSections(text, null).present)
  const scores = roles.map((role) => ({
    role,
    present: detectSections(text, role).present.filter(
      (name) => !frame.has(name)
    ).length,
  }))
  const best = Math.max(...scores.map((score) => score.present))
  if (best === 0) return null
  const winners = scores.filter((score) => score.present === best)
  return winners.length === 1 ? (winners[0]?.role ?? null) : null
}

function cloneMessage(message: ModelMessage): ModelMessage {
  return JSON.parse(JSON.stringify(message)) as ModelMessage
}

/**
 * Re-exported for the route/CLI to turn prior UI `history` into model messages
 * before passing it in (the same helper the machine uses internally).
 */
export { convertToModelMessages }

/** A promise with its resolver exposed, so the stream can settle `done` later. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const holder: { resolve: (value: T) => void } = { resolve: noop }
  const promise = new Promise<T>((resolve) => {
    holder.resolve = resolve
  })
  return { promise, resolve: (value: T) => holder.resolve(value) }
}

/** A shared no-op so `deferred`'s holder needs no definite-assignment assertion. */
function noop(): void {
  // intentionally empty
}
