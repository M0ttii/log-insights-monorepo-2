import {
  investigationScopeSchema,
  runLimitsSchema,
} from "@workspace/agent/ai-sdk"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { answerRoleSchema } from "@workspace/domain/answer"
import { z } from "zod"
import { parse } from "yaml"

export const EVAL_VERSION = "1.0.0"
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/)
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const questionSchema = z
  .strictObject({
    id,
    kind: z.enum(["role_answer", "routing_control"]),
    role: answerRoleSchema.nullable(),
    effective_role: answerRoleSchema.nullable(),
    covers: z.array(z.string()),
    common_case: id.optional(),
    question: z.string().min(1).max(4000),
    scope: z.record(z.string(), z.json()),
    required_evidence: z.array(z.string()).min(1),
    distinguishing_check: z.string().min(1),
    allowed_tool_sequences: z.array(z.array(z.string())),
    demo: z.boolean().optional(),
    reference: z.record(z.string(), z.json()).optional(),
    reference_provenance: z.array(z.string()).optional(),
  })
  .superRefine((question, ctx) => {
    if (
      (question.kind === "routing_control") !==
      (question.effective_role === null)
    )
      ctx.addIssue({
        code: "custom",
        message: "Question kind and effective role disagree",
      })
    if (question.role !== null && question.role !== question.effective_role)
      ctx.addIssue({
        code: "custom",
        message: "Explicit and effective roles disagree",
      })
  })
export type EvalQuestion = z.infer<typeof questionSchema>
/** Normalize the bank's human-readable aliases exactly once for run/review. */
export function normalizeQuestionScope(question: Pick<EvalQuestion, "scope">) {
  const { dataset, from, to, filters: nestedFilters, ...other } = question.scope
  const filters = {
    ...z
      .record(z.string(), z.json())
      .parse(nestedFilters === undefined ? {} : nestedFilters),
    ...other,
  }
  if (typeof filters.component === "string") {
    filters.components = [filters.component]
    delete filters.component
  }
  if (typeof filters.team === "string") {
    filters.teams = [filters.team]
    delete filters.team
  }
  return investigationScopeSchema.parse({
    ...(dataset === undefined ? {} : { dataset }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    filters,
  })
}
const questionBankFields = {
  version: z.literal(2),
  reference_data_version: z.string(),
  reference_status: z.literal("historical_unverified"),
  reference_provenance: z.array(z.string()).min(1),
  questions: z.array(questionSchema).min(1),
}
/** Released holdout projections do not inherit development-bank coverage quotas. */
export const releasedEvaluationBankSchema = z.strictObject(questionBankFields)
export const questionBankSchema = z
  .strictObject(questionBankFields)
  .superRefine((bank, ctx) => {
    const ids = bank.questions.map((q) => q.id)
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "Duplicate question IDs" })
    for (const role of answerRoleSchema.options) {
      if (bank.questions.filter((q) => q.role === role).length < 3)
        ctx.addIssue({
          code: "custom",
          message: `At least three explicit ${role} questions required`,
        })
      if (
        !bank.questions.some(
          (q) => q.role === null && q.effective_role === role
        )
      )
        ctx.addIssue({
          code: "custom",
          message: `Missing auto ${role} question`,
        })
    }
    for (const acceptance of ["S-06", "S-07", "S-10", "S-14", "S-15", "S-16"])
      if (!bank.questions.some((q) => q.covers.includes(acceptance)))
        ctx.addIssue({ code: "custom", message: `Missing ${acceptance}` })
    if (
      !bank.questions.some(
        (q) => q.kind === "routing_control" && q.effective_role === null
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Missing ambiguous routing control",
      })
  })
export type QuestionBank = z.infer<typeof questionBankSchema>
export async function loadQuestions(
  path = fileURLToPath(new URL("../questions/dev.yaml", import.meta.url))
): Promise<QuestionBank> {
  return questionBankSchema.parse(parse(await readFile(path, "utf8")))
}
const plannedAttemptSchema = z.strictObject({
  id,
  question_id: id,
  variant: z.enum(["baseline", "playbook"]),
  repetition: z.number().int().positive(),
  order: z.number().int().nonnegative(),
  required: z.literal(true),
  experiment: z.enum(["roles", "effort"]).optional(),
  effort: z.enum(["high", "medium"]).optional(),
})
export type PlannedAttempt = z.infer<typeof plannedAttemptSchema>
export function makePlan(
  bank: QuestionBank,
  repeated: string[]
): PlannedAttempt[] {
  if (new Set(repeated).size !== repeated.length)
    throw new Error("Repeated questions must be unique")
  for (const role of answerRoleSchema.options)
    if (
      repeated.filter((questionId) =>
        bank.questions.some(
          (q) => q.id === questionId && q.effective_role === role
        )
      ).length !== 1
    )
      throw new Error(`Choose exactly one repeated question for ${role}`)
  if (repeated.length !== 3) throw new Error("Choose three repeated questions")
  const attempts: PlannedAttempt[] = []
  let pair = 0
  for (const question of bank.questions) {
    const repetitions = repeated.includes(question.id) ? 3 : 1
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const variants =
        pair % 2 === 0
          ? (["baseline", "playbook"] as const)
          : (["playbook", "baseline"] as const)
      for (const variant of variants)
        attempts.push(
          plannedAttemptSchema.parse({
            id: `${question.id}-${variant}-${repetition}`,
            question_id: question.id,
            variant,
            repetition,
            order: attempts.length,
            required: true,
          })
        )
      pair += 1
    }
  }
  return attempts
}
const referenceSchema = z.strictObject({
  file: z.string().regex(/^(runs|receipts)\/[a-z0-9_]+\.json$/),
  sha256: hashSchema,
})
export const manifestSchema = z
  .strictObject({
    schema_version: z.literal(EVAL_VERSION),
    round_id: id,
    created_at: z.iso.datetime(),
    split: z.enum(["development", "regression", "holdout_first", "fixture"]),
    fixture_only: z.boolean(),
    versions: z.strictObject({
      code_commit: z.string(),
      code_dirty: z.boolean(),
      code_sha256: hashSchema,
      questions_sha256: hashSchema,
      tools_sha256: hashSchema,
      prompts_sha256: hashSchema,
      rubric_version: z.string(),
      rubric_sha256: hashSchema,
      data_version: z.string(),
    }),
    model: z.strictObject({
      id: z.string(),
      effort: z.string(),
      provider_options: z.json(),
    }),
    limits: runLimitsSchema.extend({
      max_revisions: z.literal(1),
      max_retries: z.literal(0),
      output_limit: z.number().nullable(),
      context_limit: z.number().nullable(),
    }),
    initial_history: z.literal("empty"),
    pricing: z
      .strictObject({
        model_id: z.string(),
        currency: z.string(),
        date: z.string(),
        url: z.url(),
        input_per_million: z.number().nonnegative(),
        output_per_million: z.number().nonnegative(),
        cache_read_per_million: z.number().nonnegative(),
        cache_write_per_million: z.number().nonnegative(),
      })
      .nullable(),
    instructions: z.record(z.string(), z.json()),
    tool_catalog: z.array(z.json()),
    repeated_questions: z.array(id),
    attempts: z.array(plannedAttemptSchema).min(1),
    holdout: z
      .strictObject({
        set_id: id,
        frozen_base_commit: z.string().regex(/^[a-f0-9]{40,64}$/),
        question_commit: z.string().regex(/^[a-f0-9]{40,64}$/),
        freeze_sha256: hashSchema,
        release_sha256: hashSchema,
        public_questions_sha256: hashSchema,
        file: z
          .string()
          .regex(/^holdout-[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.yaml$/),
        human_question_ids: z.array(id).length(3),
        judge_max_bytes: z.number().int().positive(),
      })
      .optional(),
    experiment: z
      .strictObject({
        version: z.literal("log53-v1"),
        effort_question_ids: z.array(id).length(3),
        human_question_ids: z.array(id).length(3),
        common_case: id,
        judge_max_bytes: z.number().int().positive(),
        planned_judge_calls: z.number().int().positive(),
        input_tokens_per_call_estimate: z.number().int().positive(),
        estimated_model_cost: z.number().nonnegative(),
        estimated_judge_cost: z.number().nonnegative().nullable(),
        estimate_note: z.string().min(1),
        maximum_model_calls: z.number().int().positive(),
        maximum_elapsed_ms: z.number().int().positive(),
      })
      .optional(),
  })
  .superRefine((manifest, ctx) => {
    const ids = manifest.attempts.map((a) => a.id)
    if (
      new Set(ids).size !== ids.length ||
      manifest.attempts.some((a, i) => a.order !== i)
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid attempt order or duplicate IDs",
      })
    if (
      (manifest.split === "holdout_first") !==
      (manifest.holdout !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Holdout provenance and split disagree",
      })
    if ((manifest.split === "fixture") !== manifest.fixture_only)
      ctx.addIssue({
        code: "custom",
        message: "Fixture flag and split disagree",
      })
  })
export type EvalManifest = z.infer<typeof manifestSchema>
export const attemptSchema = z.strictObject({
  schema_version: z.literal(EVAL_VERSION),
  plan: plannedAttemptSchema,
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime(),
  elapsed_ms: z.number().nonnegative(),
  status: z.enum(["completed", "error", "aborted"]),
  error_kind: z.string().nullable(),
  record: referenceSchema.nullable(),
  receipts: z.array(referenceSchema),
  missing_receipts: z.array(z.string()),
})
export type EvalAttempt = z.infer<typeof attemptSchema>
