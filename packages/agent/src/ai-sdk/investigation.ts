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
import { DATASET_IDS } from "@workspace/domain/datasets"
import { datasetSchema, filterSchema } from "@workspace/domain/filters"
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
  type InferUIMessageChunk,
  type ModelMessage,
  type StopCondition,
  type StreamTextResult,
  type SystemModelMessage,
  type ToolSet,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai"
import { z } from "zod"

import { baselineRoleInstruction } from "./baseline.ts"
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
  type AnswerVersion,
  type RunPhase,
  type RunRecord,
  type RunStatus,
  type RunStep,
  type RunStore,
  type RunUsage,
} from "./run-record.ts"
import { buildTools, modelView, toExecuteResult } from "./tools.ts"

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
    dataset: z
      .union([
        datasetSchema,
        z
          .array(datasetSchema)
          .min(1)
          .max(DATASET_IDS.length)
          .refine(
            (datasets) => new Set(datasets).size === datasets.length,
            "Question scope datasets must be unique."
          ),
      ])
      .optional()
      .describe(
        "One dataset or separate datasets named by the question; no shared time axis."
      ),
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

/** Shared role instructions and parsed coverage from the playbook loader. */
export type InvestigationPlaybooks = {
  version: string
  instructions: string
  systemPrompt: (role: AnswerRole) => string
  /**
   * The shared safety/domain/number rules (common.md without Routing), exactly
   * the eval baseline's "gemeinsame Grundlage" (technical.md § 10, § 13.2):
   * `loadPlaybooks().sharedRules`. The baseline system prompt and recorded
   * instruction texts are built from this — there is no second hand-written
   * copy of the playbook rules (AGENTS.md).
   */
  sharedRules: string
  /**
   * Per-role required evidence. When absent for an injected caller, only
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
  /** Trusted, server-restored model history, including signed thinking. */
  history?: ModelMessage[]
  /** Injectable clock for the run record timestamps (tests). */
  now?: () => Date
}

/** Typed data parts of the UI message stream (ui-concept § 12). */
type PhaseBoundary = {
  kind: "preflight" | "investigate" | "answer" | "revise"
  draft: "draft" | "final"
  /** Public, bounded coverage labels/check summary; never the system hint. */
  requirement?: string
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
  stream: ReadableStream<InferUIMessageChunk<InvestigationUIMessage>>
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
  modelSteps: number
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
  private readonly onCallerAbort: () => void
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
  private readonly instructionMessages: string[] = []
  private readonly gateFindingsPerDraft: GateFinding[][] = []
  private readonly answerVersions: AnswerVersion[] = []
  private activePhase: RunPhase["kind"] = "preflight"
  private toolSequence = 0
  private readonly completedSequences = new Set<number>()
  private modelCalls = 0

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
  /**
   * The run's data version (technical.md § 11.1): the preflight describe_corpus
   * receipt's `data_version`, falling back to the first successful tool
   * receipt; null only when no tool succeeded.
   */
  private dataVersion: string | null = null

  constructor(
    private readonly input: ParsedInput,
    private readonly deps: InvestigationDeps,
    private readonly limits: InvestigationLimits,
    private readonly callerSignal: AbortSignal,
    private readonly now: () => Date
  ) {
    this.startedAt = now()

    // Combine the caller's signal with the run's own timeout: either aborts
    // the model and the tools. A pre-aborted caller signal aborts at once.
    this.onCallerAbort = () => this.controller.abort(callerSignal.reason)
    if (callerSignal.aborted) this.onCallerAbort()
    else
      callerSignal.addEventListener("abort", this.onCallerAbort, { once: true })
    this.timer = setTimeout(() => {
      this.timedOut = true
      this.controller.abort(new Error("investigation timeout"))
    }, limits.timeoutMs)
    this.timer.unref?.()

    this.system = buildSystem(input, deps.playbooks)
    this.tools = buildTools(
      { ...deps.registry, runTool: this.runTool.bind(this) },
      deps.callContext
    )
  }

  run(): InvestigationResult {
    const gate = deferred<RunRecord>()

    const stream = createUIMessageStream<InvestigationUIMessage>({
      execute: async ({ writer }) => {
        try {
          await this.execute(writer)
        } finally {
          clearTimeout(this.timer)
          this.callerSignal.removeEventListener("abort", this.onCallerAbort)
          const record = this.buildRecord()
          await this.deps.runs.put(record).catch(() => undefined)
          this.emitFinalize(writer, record)
          gate.resolve(record)
        }
      },
      onError: () => "An error occurred during the investigation.",
    })

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
    if (this.deps.history !== undefined)
      this.messages.push(...this.deps.history.map(cloneMessage))
    else if (this.input.history !== undefined && this.input.history.length > 0)
      this.messages.push(...(await convertToModelMessages(this.input.history)))

    // describe_corpus runs in code through the registry: Opus 5.5 rejects a
    // forced tool choice, but the entry after common.md is mandatory (§ 11.1).
    const call = this.deps.callContext(this.controller.signal)
    const outcome = await this.runTool("describe_corpus", {}, call)
    const toolCallId = `preflight_describe_corpus_${this.runId}`

    writer.write({
      type: "tool-input-available",
      toolCallId,
      toolName: "describe_corpus",
      input: {},
    })

    // The UI tool part carries the FULL ToolResult, in the same
    // ToolExecuteResult shape the tool adapter returns, so both paths map a
    // ToolError identically (technical.md § 11.1: "die UI erhält das volle
    // ToolResult"). The shared helper lives in tools.ts.
    writer.write({
      type: "tool-output-available",
      toolCallId,
      output: toExecuteResult(outcome),
    })

    let contextLine: string
    if (outcome.ok) {
      const { receipt } = outcome.result
      this.coverageSteps.push({ tool: "describe_corpus", input: {}, ok: true })
      // The run's data version is the preflight describe_corpus receipt's.
      this.recordDataVersion(receipt.data_version)
      // The first user message gets the SAME compact model view every other
      // tool produces: data, all facts (id/metric/value/unit/group), notes,
      // truncated, receipt_id — no SQL, no params. No truncation of facts or
      // the datasets JSON, so every fact ID and answer_guidance reaches the
      // model (technical.md § 11.1).
      contextLine = JSON.stringify(modelView(outcome.result))
    } else {
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
    let requirement: string | undefined
    for (;;) {
      await this.runInvestigatePhase(writer, requirement)
      if (this.budgetExhausted()) return

      const followUp = this.coverageFollowUp()
      if (followUp === null || followUps >= this.limits.maxFollowUps) return
      followUps += 1
      this.coverageRequests.push(followUp.hint)
      this.pushSystem(followUp.hint)
      requirement = followUp.requirement
    }
  }

  private async runInvestigatePhase(
    writer: Writer,
    requirement?: string
  ): Promise<void> {
    this.requireModelBudget()
    writer.write({
      type: "data-phase",
      data: {
        kind: "investigate",
        draft: "draft",
        ...(requirement === undefined ? {} : { requirement }),
      },
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
  private coverageFollowUp(): { hint: string; requirement: string } | null {
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
    const check = lastCheck(this.checks)
    const parts = [coverageHint(missing), claimsHint(check)]
    const present = parts.filter((part): part is string => part !== null)
    if (present.length === 0) return null
    // The model never supplies this line: only code-owned coverage labels and
    // validated check counts are public. Keep the full corrective hint private.
    const labels = missing.map((item) => item.label)
    if (check !== null) {
      if (check.summary.mismatch > 0)
        labels.push(
          `${check.summary.mismatch} claim(s) mismatch their cited fact`
        )
      if (check.summary.unresolved > 0)
        labels.push(
          `${check.summary.unresolved} claim(s) cite an unknown fact or receipt`
        )
    }
    const label = labels.join("; ").replace(/\s+/g, " ").trim()
    return {
      hint: present.join(" "),
      requirement: label.length <= 1000 ? label : `${label.slice(0, 997)}...`,
    }
  }

  private roleCoverage(): RoleCoverage | null {
    const role = this.resolvedAnswerRole()
    if (role === null) return null
    return this.deps.playbooks.coverage?.[role] ?? null
  }

  // --- answer -------------------------------------------------------------

  private async answerPhase(writer: Writer): Promise<string> {
    this.requireModelBudget()
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
      // Role-core templates are playbook content. Feeding their missing
      // section names into baseline revision would leak the answer template.
      role:
        this.input.variant === "baseline" ? null : this.resolvedAnswerRole(),
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
    this.requireModelBudget()
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
    this.requireModelBudget()
    const remaining = this.limits.maxSteps - this.stepsUsed
    this.activePhase = kind
    let version: AnswerVersion | undefined

    const prompt: PhasePrompt = {
      system: this.system,
      messages: this.messages.map(cloneMessage),
    }
    this.assertPrefixExtension(prompt)
    this.prompts.push(prompt)
    this.previousPrompt = prompt

    let modelErrored = false
    const result = streamText({
      model: this.deps.model.model as LanguageModel,
      system: this.system,
      messages: this.messages,
      tools: this.tools,
      // A failed provider request is counted once and never silently retried.
      maxRetries: 0,
      onLanguageModelCallStart: () => {
        this.modelCalls += 1
        // A tool-loop continuation is another assistant message. Preserve its
        // own first-text boundary rather than joining it to earlier prose.
        version = undefined
      },
      onChunk: ({ chunk }) => {
        if (chunk.type === "tool-call" && chunk.dynamic && chunk.invalid) {
          this.recordRejectedTool(chunk.toolName, chunk.input)
          return
        }
        if (kind === "investigate" || chunk.type !== "text-delta") return
        if (version === undefined) {
          const startedAt = this.now().toISOString()
          const completed = [...this.completedSequences].toSorted(
            (a, b) => a - b
          )
          version = {
            text: "",
            phase: kind,
            started_at: startedAt,
            completed_at: startedAt,
            after_sequence: completed.at(-1) ?? 0,
            completed_sequences: completed,
          }
          this.answerVersions.push(version)
        }
        version.text += chunk.text
        version.completed_at = this.now().toISOString()
      },
      allowSystemInMessages: true,
      // The provider options are the typed Anthropic options from model.ts.
      // streamText types `providerOptions` as a plain JSON record; the typed
      // Anthropic options (e.g. `fallbacks`) are a structural superset of JSON,
      // so this one localized cast bridges the two without widening model.ts.
      providerOptions: this.deps.model
        .providerOptions as StreamTextProviderOptions,
      abortSignal: this.controller.signal,
      stopWhen: stopCondition(kind, remaining),
      // The SDK default logs raw provider errors with headers and payloads.
      // Only the sanitized run status may leave this adapter.
      onError: () => {
        modelErrored = true
      },
    }) as StreamTextResult<ToolSet, never, never>

    writer.merge(
      result.toUIMessageStream<InvestigationUIMessage>({ sendStart: false })
    )

    const outcome = await this.readPhase(result)
    this.messages.push(...outcome.responseMessages)
    this.recordOutcome(outcome)

    if (outcome.aborted) this.throwIfAborted()
    if (outcome.errored || modelErrored) {
      this.status = "error"
      this.errorKind = "model_error"
      throw new Error("The model call failed.")
    }
    if (outcome.finishReason === "content-filter") {
      this.status = "refusal"
      throw new Error("The model declined the request.")
    }
    // A tool-only last step still needs a continuation to write the answer.
    // At the global cap it remains an incomplete run, including in revision.
    if (outcome.finishReason === "tool-calls") this.requireModelBudget()
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
        modelSteps: steps.length,
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

  private recordOutcome(outcome: ModelPhaseOutcome): void {
    addUsage(this.usageTotal, outcome.usage)
    this.stepsUsed += Math.max(1, outcome.modelSteps)
    for (const step of outcome.steps) {
      const view = stepView(step.output)
      this.coverageSteps.push({
        tool: step.toolName,
        input: step.input,
        ok: view.errorKind === null,
      })
      // Fallback data version: the first successful tool receipt of the run,
      // used only when the preflight describe_corpus did not set it.
      if (view.errorKind === null) this.recordDataVersion(view.dataVersion)
      if (step.toolName === "check_claims" && view.checkOutput !== null) {
        this.checks.push({
          receipt_id: view.receiptId ?? "",
          output: view.checkOutput,
        })
      }
    }
  }

  /** Records the run's data version from the first tool receipt that has one. */
  private recordDataVersion(dataVersion: string | null | undefined): void {
    if (this.dataVersion === null && typeof dataVersion === "string")
      this.dataVersion = dataVersion
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
      data_version: this.dataVersion,
      instruction_texts: this.instructionTexts(),
      instruction_messages: this.instructionMessages,
      phases: this.phases,
      model_calls: this.modelCalls,
      answer_versions: this.answerVersions,
      limits: {
        max_steps: this.limits.maxSteps,
        max_follow_ups: this.limits.maxFollowUps,
        max_revisions: this.limits.maxRevisions,
        timeout_ms: this.limits.timeoutMs,
        max_retries: 0,
      },
      coverage_requests: this.coverageRequests,
      gate_findings: this.gateFindingsPerDraft.map((findings) =>
        findings.map((finding) => gateFindingSchema.parse(finding))
      ),
      usage: this.usageTotal,
      final_text: stoppedOrTimedOut ? null : this.finalText,
      model_history: this.messages.map(cloneMessage),
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
      // The actual parts of the baseline system text (§ 11.1, § 13.2): the
      // shared rules from the playbooks and the simple role instruction.
      return [
        this.deps.playbooks.sharedRules,
        baselineRoleInstruction(this.input.role),
      ]
    }
    return [this.system]
  }

  // --- helpers ------------------------------------------------------------

  /** Records execution as it happens; SDK phase-end results lose chronology. */
  private async runTool(
    name: string,
    input: unknown,
    call: CallContext
  ): ReturnType<Registry["runTool"]> {
    const startedAt = this.now()
    this.toolSequence += 1
    const sequence = this.toolSequence
    const step: RunStep = {
      sequence,
      started_at: startedAt.toISOString(),
      tool: name,
      input: z.json().parse(input),
      input_validated: true,
      receipt_id: null,
      duration_ms: 0,
      error_kind: null,
    }
    this.recordStep(this.activePhase, step)
    try {
      const outcome = await this.deps.registry.runTool(name, input, call)
      if (outcome.ok) {
        step.input = z.json().parse(outcome.result.receipt.input)
        step.receipt_id = outcome.result.receipt.receipt_id
      } else step.error_kind = outcome.error.code
      return outcome
    } catch (error) {
      step.error_kind = call.signal.aborted ? "cancelled" : "db_unavailable"
      throw error
    } finally {
      const finishedAt = this.now()
      step.finished_at = finishedAt.toISOString()
      step.duration_ms = Math.max(0, finishedAt.getTime() - startedAt.getTime())
      this.completedSequences.add(sequence)
    }
  }

  /** SDK schema errors never enter the registry but still count as attempts. */
  private recordRejectedTool(name: string, input: unknown): void {
    const timestamp = this.now().toISOString()
    this.toolSequence += 1
    const parsed = z.json().safeParse(input)
    this.recordStep(this.activePhase, {
      sequence: this.toolSequence,
      started_at: timestamp,
      finished_at: timestamp,
      tool: name,
      input: parsed.success ? parsed.data : null,
      input_validated: false,
      receipt_id: null,
      duration_ms: 0,
      error_kind: "invalid_input",
    })
    this.completedSequences.add(this.toolSequence)
  }

  private recordStep(kind: RunPhase["kind"], step: RunStep): void {
    const last = this.phases.at(-1)
    if (last !== undefined && last.kind === kind) last.steps.push(step)
    else this.phases.push({ kind, steps: [step] })
  }

  private pushSystem(text: string): void {
    this.instructionMessages.push(text)
    // Anthropic accepts textual mid-conversation system messages only after
    // a user turn (SDK tool results serialize as a user turn). A completed
    // answer therefore needs a new continuation turn before revision hints.
    // Append both; never rewrite the signed thinking/history prefix.
    const previous = this.messages.at(-1)
    if (previous?.role !== "user" && previous?.role !== "tool")
      this.messages.push({
        role: "user",
        content: "Continue the investigation.",
      })
    const message: SystemModelMessage = { role: "system", content: text }
    this.messages.push(message)
  }

  private budgetExhausted(): boolean {
    return this.stepsUsed >= this.limits.maxSteps
  }

  private requireModelBudget(): void {
    if (!this.budgetExhausted()) return
    this.status = "error"
    this.errorKind = "limit_exceeded"
    throw new Error("The investigation step limit was reached.")
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
    if (this.status === "refusal" || this.status === "error") return
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
    // Baseline (§ 13.2): the SAME shared safety/domain/number rules as the
    // playbook variant (playbooks.sharedRules, § 10) plus only the simple role
    // instruction — no playbook content, no second copy of the rules.
    return `${playbooks.sharedRules}\n\n${baselineRoleInstruction(input.role)}`
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

/** Ends investigation once claims are checked; answer/revision still need text. */
const STOP_AFTER_CHECK_CLAIMS: StopCondition<ToolSet> = ({ steps }) =>
  steps.some((step) =>
    step.toolCalls.some((call) => call.toolName === "check_claims")
  )

/** Every phase shares the remaining cap; only investigate stops at a check. */
function stopCondition(
  kind: PhaseKind,
  remainingSteps: number
): StopCondition<ToolSet>[] {
  const stepCap: StopCondition<ToolSet> = ({ steps }) =>
    steps.length >= remainingSteps
  return kind === "investigate" ? [STOP_AFTER_CHECK_CLAIMS, stepCap] : [stepCap]
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
  dataVersion: string | null
  errorKind: string | null
  checkOutput: CheckClaimsOutput | null
}

/**
 * Reads the adapter's tool output into a compact view. The adapter's execute
 * value is `{ ok: true, result }` with the full `ToolResult` on success or
 * `{ ok: false, error: {...} }` on an expected failure (tools.ts). The compact
 * model-output shapes (`{ data, facts, receipt_id }` / `{ error: {...} }`) are
 * also handled, so the reader works whether the SDK hands back the execute
 * value or the model view. `dataVersion` is only available from the full
 * result (the model view omits it), which the run record takes for its
 * `data_version` fallback.
 */
function stepView(output: unknown): StepView {
  if (typeof output !== "object" || output === null) return empty()
  const record = output as Record<string, unknown>

  if (record.ok === false)
    return {
      receiptId: null,
      dataVersion: null,
      errorKind: readErrorKind(
        (record.error as Record<string, unknown>)?.error
      ),
      checkOutput: null,
    }
  if (record.ok === true) {
    const result = record.result as {
      receipt?: { receipt_id?: string; data_version?: string }
      data?: unknown
    }
    return {
      receiptId: result.receipt?.receipt_id ?? null,
      dataVersion: result.receipt?.data_version ?? null,
      errorKind: null,
      checkOutput: parseCheck(result.data),
    }
  }
  if ("error" in record)
    return {
      receiptId: null,
      dataVersion: null,
      errorKind: readErrorKind(record.error),
      checkOutput: null,
    }

  return {
    receiptId: typeof record.receipt_id === "string" ? record.receipt_id : null,
    dataVersion: null,
    errorKind: null,
    checkOutput: parseCheck(record.data),
  }
}

function empty(): StepView {
  return {
    receiptId: null,
    dataVersion: null,
    errorKind: null,
    checkOutput: null,
  }
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
    modelSteps: 0,
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
