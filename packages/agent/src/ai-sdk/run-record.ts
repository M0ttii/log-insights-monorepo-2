import { randomBytes } from "node:crypto"
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"

import { findWorkspaceRoot } from "@workspace/analytics/config"
import { gateFindingSchema } from "@workspace/domain/answer"
import { z } from "zod"
import { modelMessageSchema } from "ai"

/**
 * Run record (technical.md § 11.1, "Laufprotokoll"): one JSON file per run in
 * `.data/runs/<run_id>.json` (gitignored), written atomically. It is the
 * deterministic source for the eval metrics (§ 13.3) and for "Export run"
 * (§ 11). It holds no keys, provider headers or prompts beyond the question
 * and the instruction texts of the variant (§ 11.1, § 12).
 *
 * The run id is `run_` + 8 hex digits, validated before it ever forms a path
 * (no traversal), the same shape the receipt store uses for receipt ids.
 */

export const RUN_ID_PATTERN = /^run_[0-9a-f]{8}$/

export const runIdSchema = z
  .string()
  .regex(RUN_ID_PATTERN)
  .describe(
    "Run id: run_ followed by 8 lower-case hex digits, e.g. run_1a2b3c4d."
  )

/** `run_` and 8 random hex digits. */
export function newRunId(): string {
  return `run_${randomBytes(4).toString("hex")}`
}

export const runStatusSchema = z.enum([
  "completed",
  "stopped",
  "refusal",
  "error",
  "timeout",
])

export type RunStatus = z.infer<typeof runStatusSchema>

export const runVariantSchema = z.enum(["playbook", "baseline"])

export const runRoleSchema = z.enum([
  "engineer",
  "team_lead",
  "manager",
  "auto",
])

/** The role the client asked for, and the one the run actually used (auto resolves). */
export const runRolesSchema = z.strictObject({
  requested: runRoleSchema,
  effective: runRoleSchema,
})

export const phaseKindSchema = z.enum([
  "preflight",
  "investigate",
  "coverage",
  "answer",
  "gate",
  "revise",
  "finalize",
])

export type PhaseKind = z.infer<typeof phaseKindSchema>

/** One attempted tool call. Rejected SDK arguments are marked as unvalidated. */
export const runStepSchema = z.strictObject({
  sequence: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Invocation order within the run, including preflight."),
  started_at: z.string().optional(),
  finished_at: z.string().optional(),
  tool: z.string(),
  input: z
    .json()
    .describe(
      "Tool arguments; validated unless input_validated is false. No executed SQL or bound params."
    ),
  input_validated: z
    .boolean()
    .optional()
    .describe(
      "False only for arguments the SDK rejected before registry execution."
    ),
  receipt_id: z.string().nullable(),
  duration_ms: z.number().nonnegative(),
  error_kind: z
    .string()
    .nullable()
    .describe("ToolError code when the call failed as a value, else null."),
})

export type RunStep = z.infer<typeof runStepSchema>

export const runPhaseSchema = z.strictObject({
  kind: phaseKindSchema,
  steps: z.array(runStepSchema),
})

export type RunPhase = z.infer<typeof runPhaseSchema>

/** Usage tokens; each field is nullable because the provider may not report it. */
export const runUsageSchema = z.strictObject({
  input: z.number().int().nonnegative().nullable(),
  output: z.number().int().nonnegative().nullable(),
  cache_read: z.number().int().nonnegative().nullable(),
  cache_write: z.number().int().nonnegative().nullable(),
})

export type RunUsage = z.infer<typeof runUsageSchema>

/** A check_claims summary carried into the record: the receipt and its line. */
export const checkClaimsSummarySchema = z.strictObject({
  receipt_id: z.string(),
  summary: z.json(),
})

/**
 * Gate findings for one draft: the deterministic `gateFindingSchema` from
 * `@workspace/domain/answer` (LOG-46). `gate_findings` holds one array per
 * draft (the first draft, then the revision when one ran).
 */
export const gateFindingsSchema = z.array(gateFindingSchema)

/** Each answer/revision assistant message retains its first-text boundary. */
export const answerVersionSchema = z.strictObject({
  text: z.string(),
  phase: z.enum(["answer", "revise"]),
  started_at: z.string(),
  completed_at: z.string(),
  after_sequence: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Latest tool invocation completed before the first text chunk of this version."
    ),
  completed_sequences: z
    .array(z.number().int().positive())
    .optional()
    .describe(
      "Exact completed invocations at first text, including when parallel calls finish out of order."
    ),
})

export type AnswerVersion = z.infer<typeof answerVersionSchema>

export const runLimitsSchema = z.strictObject({
  max_steps: z.number().int().positive(),
  max_follow_ups: z.number().int().nonnegative(),
  max_revisions: z.number().int().nonnegative(),
  timeout_ms: z.number().positive(),
  max_retries: z.number().int().nonnegative(),
})

export const runRecordSchema = z.strictObject({
  run_id: runIdSchema,
  started_at: z.string().describe("ISO-8601 UTC start of the run."),
  finished_at: z.string().describe("ISO-8601 UTC end of the run."),
  duration_ms: z.number().nonnegative(),
  status: runStatusSchema,
  variant: runVariantSchema,
  role: runRolesSchema,
  question: z.string(),
  scope: z
    .json()
    .describe("Structured scope (dataset, window, filters) or null."),
  model_id: z.string(),
  effort: z.string(),
  guidance_version: z
    .string()
    .describe("Playbook bundle version the variant's guidance came from."),
  contract_version: z.string(),
  data_version: z.string().nullable(),
  instruction_texts: z
    .array(z.string())
    .describe("Instruction texts of the variant; no other prompt content."),
  instruction_messages: z
    .array(z.string())
    .optional()
    .describe(
      "Code-owned phase, coverage and gate system messages sent during this run, in order."
    ),
  phases: z.array(runPhaseSchema),
  // Optional so earlier persisted records and web exports remain readable.
  model_calls: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Provider calls started, including failed calls and tool-loop continuations."
    ),
  limits: runLimitsSchema.optional(),
  answer_versions: z.array(answerVersionSchema).optional(),
  coverage_requests: z
    .array(z.string())
    .describe("The coverage hint texts sent back to the model, in order."),
  gate_findings: z
    .array(gateFindingsSchema)
    .describe("Gate findings per draft (one array per draft/revision)."),
  usage: runUsageSchema,
  final_text: z.string().nullable(),
  // Private, authoritative continuation state. Never included in web exports.
  // Optional for records written before full-history persistence was added.
  model_history: z.array(modelMessageSchema).optional(),
  check_claims: z.array(checkClaimsSummarySchema),
  error_kind: z.string().nullable(),
})

export type RunRecord = z.infer<typeof runRecordSchema>

/** Persists run records; the file implementation writes one JSON per run. */
export type RunStore = {
  put(record: RunRecord): Promise<void>
  get(id: string): Promise<RunRecord | null>
}

/**
 * Resolves the runs directory the same way the receipt store resolves its
 * directory (technical.md § 4): from the workspace root, never `process.cwd()`.
 * `LOG_INSIGHTS_RUNS_DIR` overrides it (declared in turbo.json); a relative
 * override is resolved against the repository root, not the working directory.
 */
export function resolveRunsDir(
  env: Record<string, string | undefined> = process.env
): string {
  const override = env.LOG_INSIGHTS_RUNS_DIR
  const root = findWorkspaceRoot()
  if (override === undefined || override === "")
    return join(root, ".data", "runs")
  return isAbsolute(override) ? override : resolve(root, override)
}

function checkId(id: string): string {
  if (!RUN_ID_PATTERN.test(id))
    throw new RangeError(`invalid run id: ${JSON.stringify(id)}`)
  return id
}

function errorCode(error: unknown): string | undefined {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code
  return undefined
}

/**
 * One JSON file per run. Like the receipt store it writes a temporary file
 * exclusively (`wx`), then links it to the final name and removes the
 * temporary one: `link` is atomic and never clobbers an existing file, so a
 * reader never sees half a file.
 */
export class FileRunStore implements RunStore {
  constructor(readonly dir: string) {}

  async put(record: RunRecord): Promise<void> {
    const id = checkId(record.run_id)
    const json = `${JSON.stringify(runRecordSchema.parse(record), null, 2)}\n`
    await mkdir(this.dir, { recursive: true })
    const temporary = join(
      this.dir,
      `.${id}.${randomBytes(6).toString("hex")}.tmp`
    )
    await writeFile(temporary, json, { flag: "wx", mode: 0o644 })
    try {
      await link(temporary, this.path(id))
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }

  async get(id: string): Promise<RunRecord | null> {
    if (!RUN_ID_PATTERN.test(id)) return null
    let text: string
    try {
      text = await readFile(this.path(id), "utf8")
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null
      throw error
    }
    return runRecordSchema.parse(JSON.parse(text))
  }

  private path(id: string): string {
    return join(this.dir, `${checkId(id)}.json`)
  }
}
