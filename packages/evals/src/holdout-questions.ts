import { createHash } from "node:crypto"
import { z } from "zod"
import { investigationScopeSchema } from "@workspace/agent/ai-sdk"
import { answerRoleSchema } from "@workspace/domain/answer"
import {
  releasedEvaluationBankSchema,
  type PlannedAttempt,
} from "./contracts.ts"
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/)
const role = answerRoleSchema
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error("Invalid holdout artifact")
  return result.data
}
const holdoutQuestionSchema = z.strictObject({
  id,
  role,
  question: z.string().min(1).max(4000),
  scope: investigationScopeSchema.refine((scope) => {
    const datasets = Array.isArray(scope.dataset)
      ? scope.dataset
      : [scope.dataset]
    return datasets.every((dataset) =>
      ["bgl", "openstack"].includes(dataset ?? "")
    )
  }, "An explicit base-corpus dataset is required"),
})
export const holdoutQuestionBankSchema = z
  .strictObject({
    schema_version: z.literal(1),
    set_id: id,
    questions: z.array(holdoutQuestionSchema).min(6).max(300),
  })
  .refine(
    (bank) =>
      new Set(bank.questions.map((question) => question.id)).size ===
      bank.questions.length,
    "Question IDs must be unique"
  )

/** Parse first and select only agent input. Reviewer material has no route here. */
export function holdoutInvestigationInput(value: unknown) {
  const question = checked(holdoutQuestionSchema, value)
  return {
    question: question.question,
    role: question.role,
    scope: question.scope,
  }
}

/** Reviewer metadata is the frozen public rubric, never sealed expectations. */
export function projectHoldoutQuestions(value: unknown, dataVersion: string) {
  const bank = holdoutQuestionBankSchema.parse(value)
  return releasedEvaluationBankSchema.parse({
    version: 2,
    reference_data_version: dataVersion,
    reference_status: "historical_unverified",
    reference_provenance: [
      "Released public questions only; no private expected values are part of this snapshot.",
    ],
    questions: bank.questions.map((question) => ({
      ...question,
      kind: "role_answer",
      effective_role: question.role,
      covers: ["S-11"],
      required_evidence: [
        "Independently assess role-relevant evidence against the frozen rubric and separately held expectations.",
      ],
      distinguishing_check:
        "Independently assess the performed decision-changing check for the requested role.",
      allowed_tool_sequences: [["describe_corpus"]],
    })),
  })
}

/** Reconstruct the frozen role/ordinal ordering without inspecting any answer. */
export function releasedHoldoutPlan(value: unknown): PlannedAttempt[] {
  const bank = holdoutQuestionBankSchema.parse(value)
  const plan: PlannedAttempt[] = []
  let pair = 0
  for (const requestedRole of answerRoleSchema.options)
    for (const question of bank.questions.filter(
      (q) => q.role === requestedRole
    )) {
      const variants =
        pair % 2 === 0
          ? (["baseline", "playbook"] as const)
          : (["playbook", "baseline"] as const)
      for (const variant of variants)
        plan.push({
          id: `ho_${createHash("sha256").update(`${bank.set_id}/${question.id}/${variant}/1`).digest("hex").slice(0, 40)}`,
          question_id: question.id,
          variant,
          repetition: 1,
          order: plan.length,
          required: true,
          experiment: "roles",
          effort: "high",
        })
      pair += 1
    }
  return plan
}

/** Preserve the frozen role/ordinal mapping; callers retain their own guards. */
export function bindHoldoutSlots<
  Slot extends { role: z.infer<typeof answerRoleSchema>; ordinal: number },
>(slots: readonly Slot[], bank: z.infer<typeof holdoutQuestionBankSchema>) {
  return slots.map((slot) => ({
    ...slot,
    question_id: bank.questions.filter(
      (question) => question.role === slot.role
    )[slot.ordinal - 1]?.id,
  }))
}
