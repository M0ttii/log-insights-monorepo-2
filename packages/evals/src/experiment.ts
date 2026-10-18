import { canonicalJson } from "@workspace/domain/receipt"
import {
  makePlan,
  type PlannedAttempt,
  type QuestionBank,
} from "./contracts.ts"

export const REPEATED_QUESTIONS = ["dev-eng-01", "dev-tl-01", "dev-mgr-01"]
const COMMON_CASE = "bgl-june-ciod"
export const EXPERIMENT_LIMITS = {
  maxSteps: 16,
  maxFollowUps: 2,
  maxRevisions: 1,
  timeoutMs: 180_000,
  maxModelCalls: 16,
  maxOutputTokens: 4096,
  maxInputBytes: 262_144,
} as const
export const OPUS_PRICING = {
  model_id: "claude-opus-5-5",
  currency: "USD",
  date: "2026-10-18",
  url: "https://platform.claude.com/docs/en/about-claude/pricing",
  input_per_million: 4,
  output_per_million: 20,
  cache_read_per_million: 0.2,
  cache_write_per_million: 8,
} as const

export function validateCommonCase(bank: QuestionBank): void {
  const members = bank.questions.filter((q) => q.common_case === COMMON_CASE)
  if (
    members.length !== 3 ||
    new Set(members.map((q) => q.role)).size !== 3 ||
    members.some((q) => q.role === null || !q.covers.includes("S-13")) ||
    new Set(members.map((q) => canonicalJson(q.scope))).size !== 1 ||
    new Set(members.map((q) => q.question)).size !== 1
  )
    throw new Error(
      "S-13 common case requires the same question and structured scope for all three roles"
    )
}

/** Configuration controls are additional attempts, never role-comparison samples. */
export function experimentPlan(bank: QuestionBank): PlannedAttempt[] {
  validateCommonCase(bank)
  const plan: PlannedAttempt[] = makePlan(bank, REPEATED_QUESTIONS).map(
    (a) => ({
      ...a,
      experiment: "roles",
      effort: "high",
    })
  )
  for (const [caseIndex, questionId] of REPEATED_QUESTIONS.entries()) {
    // Alternate both effort and variant order; retain all twelve controls.
    const efforts =
      caseIndex % 2 === 0
        ? (["high", "medium"] as const)
        : (["medium", "high"] as const)
    for (const [levelIndex, effort] of efforts.entries()) {
      const variants =
        (caseIndex + levelIndex) % 2 === 0
          ? (["baseline", "playbook"] as const)
          : (["playbook", "baseline"] as const)
      for (const variant of variants)
        plan.push({
          id: `effort-${effort}-${questionId}-${variant}`,
          question_id: questionId,
          variant,
          repetition: 1,
          order: plan.length,
          required: true,
          experiment: "effort",
          effort,
        })
    }
  }
  return plan
}

export function experimentProjection(
  attempts: PlannedAttempt[],
  bank: QuestionBank
) {
  const calls = attempts.length * EXPERIMENT_LIMITS.maxModelCalls
  // One token per serialized UTF-8 byte is deliberately conservative. Provider
  // framing/tokenization is unknown: this is a forecast, never a billing cap.
  const input = EXPERIMENT_LIMITS.maxInputBytes
  return {
    version: "log53-v1" as const,
    effort_question_ids: REPEATED_QUESTIONS,
    human_question_ids: REPEATED_QUESTIONS,
    common_case: COMMON_CASE,
    judge_max_bytes: 1_048_576,
    planned_judge_calls:
      attempts.length +
      attempts.filter(
        (attempt) =>
          attempt.experiment === "roles" &&
          bank.questions.some(
            (question) =>
              question.id === attempt.question_id &&
              question.kind === "role_answer"
          )
      ).length +
      1,
    input_tokens_per_call_estimate: input,
    estimated_model_cost:
      (calls *
        (input * OPUS_PRICING.cache_write_per_million +
          EXPERIMENT_LIMITS.maxOutputTokens *
            OPUS_PRICING.output_per_million)) /
      1_000_000,
    estimated_judge_cost: null,
    estimate_note:
      "Conservative forecast using one input token per serialized UTF-8 byte and all input at the 1h cache-write rate. Not a provider-token bound or spending cap. Actual input tokens, cache reuse and reviewer API pricing are unknown until reported. Reviewer work may run offline; no reviewer API calls are automatic. Boundaries are 16 provider calls, 262144 serialized input bytes per call, 4096 output tokens per call and 180 seconds per attempt. Calibration controls run offline before review. High remains the production default.",
    maximum_model_calls: calls,
    maximum_elapsed_ms: attempts.length * EXPERIMENT_LIMITS.timeoutMs,
  }
}
