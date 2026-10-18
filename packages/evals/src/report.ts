import { readFile } from "node:fs/promises"
import { z } from "zod"
import { runUsageSchema, type RunRecord } from "@workspace/agent/ai-sdk"
import { canonicalJson } from "@workspace/domain/receipt"
import {
  digest,
  loadAttempt,
  readArtifact,
  writeArtifact,
} from "./artifacts.ts"
import {
  EVAL_VERSION,
  makePlan,
  manifestSchema,
  questionBankSchema,
  type EvalManifest,
} from "./contracts.ts"
import {
  evaluateAttempt,
  evaluationSchema,
  semanticAssessmentSchema,
  type SemanticAssessment,
} from "./evaluate.ts"
import { experimentPlan } from "./experiment.ts"

const RUBRIC_DIMENSIONS = [
  "scope",
  "evidence",
  "action",
  "decision_check",
  "causal_separation",
] as const
const USAGE_CATEGORIES = [
  "input",
  "output",
  "cache_read",
  "cache_write",
] as const

const statisticsSchema = z.strictObject({
  n: z.number().int().nonnegative(),
  median: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
})
const reportEntrySchema = z.strictObject({
  attempt_id: z.string(),
  question_id: z.string(),
  kind: z.string(),
  role: z.string().nullable(),
  variant: z.enum(["baseline", "playbook"]),
  experiment: z.enum(["roles", "effort"]),
  effort: z.string(),
  status: z.enum(["completed", "error", "aborted", "missing", "invalid"]),
  error_kind: z.string().nullable(),
  elapsed_ms: z.number().nullable(),
  model_calls: z.number().int().nullable(),
  tool_calls: z.number().int().nullable(),
  usage: runUsageSchema.nullable(),
  estimated_cost: z.number().nullable(),
  evaluation: evaluationSchema.nullable(),
})
const reportSchema = z.strictObject({
  schema_version: z.literal(EVAL_VERSION),
  round_id: z.string(),
  split: manifestSchema.shape.split,
  evaluator_version: z.string(),
  evaluator_sha256: z.string(),
  manifest_sha256: z.string(),
  assessments_sha256: z.string(),
  measurement_complete: z.boolean(),
  acceptance: z.enum([
    "not_demonstrated",
    "failed",
    "pending_external_acceptance",
  ]),
  limitations: z.array(z.string()),
  attempts: z.array(reportEntrySchema),
  groups: z.array(
    z.strictObject({
      role: z.string(),
      variant: z.enum(["baseline", "playbook"]),
      kind: z.string(),
      experiment: z.enum(["roles", "effort"]),
      effort: z.string(),
      planned: z.number(),
      completed: z.number(),
      elapsed_ms: statisticsSchema,
      model_calls: statisticsSchema,
      tool_calls: statisticsSchema,
      numerical: evaluationSchema.shape.numerical
        .pick({
          checked: true,
          verified: true,
          mismatch: true,
          unresolved: true,
          unchecked: true,
          uncited: true,
        })
        .nullable(),
      estimated_cost: z.number().nullable(),
      rubric_mean: z.number().nullable(),
      rubric_dimensions: z.record(z.string(), z.number().nullable()),
      scope_errors: z.number().int().nonnegative(),
      usage: z.record(z.string(), z.number().nullable()),
    })
  ),
  repetitions: z.array(
    z.strictObject({
      question_id: z.string(),
      variant: z.enum(["baseline", "playbook"]),
      attempt_ids: z.array(z.string()),
      elapsed_ms: statisticsSchema,
      model_calls: statisticsSchema,
      tool_calls: statisticsSchema,
      estimated_cost: statisticsSchema,
      usage: z.record(z.string(), statisticsSchema),
    })
  ),
  assessment_usage: runUsageSchema.nullable(),
  assessment_cost: z.number().nullable(),
})
export type EvalReport = z.infer<typeof reportSchema>
function statistics(values: number[]): z.infer<typeof statisticsSchema> {
  const sorted = values.toSorted((a, b) => a - b),
    n = sorted.length
  const middle = sorted[Math.floor(n / 2)],
    prior = sorted[Math.floor(n / 2) - 1]
  return {
    n,
    median:
      middle === undefined
        ? null
        : n % 2 === 0 && prior !== undefined
          ? (prior + middle) / 2
          : middle,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  }
}
function estimateCost(
  record: RunRecord,
  manifest: EvalManifest
): number | null {
  const p = manifest.pricing,
    u = record.usage
  if (
    p === null ||
    p.model_id !== record.model_id ||
    u.input === null ||
    u.output === null ||
    u.cache_read === null ||
    u.cache_write === null
  )
    return null
  const uncached = u.input - u.cache_read - u.cache_write
  if (uncached < 0) return null
  return (
    (uncached * p.input_per_million +
      u.output * p.output_per_million +
      u.cache_read * p.cache_read_per_million +
      u.cache_write * p.cache_write_per_million) /
    1_000_000
  )
}
/** Validates the immutable round independently of attempt/report availability. */
export async function loadRoundSnapshot(dir: string) {
  const manifest = manifestSchema.parse(
    await readArtifact(dir, "manifest.json")
  )
  const bank = questionBankSchema.parse(
    await readArtifact(dir, "questions.json")
  )
  if (digest(bank) !== manifest.versions.questions_sha256)
    throw new Error("Question snapshot hash differs")
  if (
    digest(manifest.instructions) !== manifest.versions.prompts_sha256 ||
    digest(manifest.tool_catalog) !== manifest.versions.tools_sha256
  )
    throw new Error("Manifest instruction/catalog hash differs")
  if (
    !manifest.fixture_only &&
    canonicalJson(
      manifest.experiment === undefined
        ? makePlan(bank, manifest.repeated_questions)
        : experimentPlan(bank)
    ) !== canonicalJson(manifest.attempts)
  )
    throw new Error("Manifest omits required attempts")
  return { manifest, bank }
}
/** Rebuilds solely from saved JSON. No model or database is constructed. */
export async function recomputeReport(
  dir: string,
  evaluatorVersion: string,
  assessments: SemanticAssessment[] = []
): Promise<EvalReport> {
  const { manifest, bank } = await loadRoundSnapshot(dir)
  const parsedAssessments = assessments.map((a) =>
    semanticAssessmentSchema.parse(a)
  )
  if (
    new Set(parsedAssessments.map((a) => a.run_id)).size !==
    parsedAssessments.length
  )
    throw new Error("Duplicate assessments for a run")
  const entries: EvalReport["attempts"] = []
  for (const plan of manifest.attempts) {
    const question = bank.questions.find((q) => q.id === plan.question_id)
    if (question === undefined) throw new Error("Planned question missing")
    const entry: z.infer<typeof reportEntrySchema> = {
      attempt_id: plan.id,
      question_id: plan.question_id,
      kind: question.kind,
      role: question.effective_role,
      variant: plan.variant,
      experiment: plan.experiment ?? "roles",
      effort: plan.effort ?? manifest.model.effort,
      status: "missing",
      error_kind: null,
      elapsed_ms: null,
      model_calls: null,
      tool_calls: null,
      usage: null,
      estimated_cost: null,
      evaluation: null,
    }
    try {
      const { attempt, record, receipts } = await loadAttempt(dir, plan)
      entry.status = attempt.status
      entry.error_kind = attempt.error_kind
      entry.elapsed_ms = attempt.elapsed_ms
      if (record !== null) {
        if (
          record.question !== question.question ||
          record.variant !== plan.variant ||
          record.role.requested !== (question.role ?? "auto") ||
          record.model_id !== manifest.model.id ||
          record.effort !== (plan.effort ?? manifest.model.effort) ||
          record.data_version !== manifest.versions.data_version ||
          receipts.some(
            (receipt) => receipt.data_version !== manifest.versions.data_version
          )
        )
          throw new Error("Run configuration differs from frozen manifest")
        entry.model_calls = record.model_calls ?? null
        entry.tool_calls = record.phases.flatMap((p) => p.steps).length
        entry.usage = record.usage
        entry.estimated_cost = estimateCost(record, manifest)
        entry.evaluation = evaluateAttempt({
          question,
          record,
          receipts,
          semanticAssessment: parsedAssessments.find(
            (a) => a.run_id === record.run_id
          ),
        })
      }
      if (attempt.missing_receipts.length > 0) {
        entry.status = "invalid"
        entry.error_kind = "missing_receipts"
      }
    } catch (error) {
      const missing =
        error instanceof Error && "code" in error && error.code === "ENOENT"
      entry.status = missing ? "missing" : "invalid"
      entry.error_kind = missing ? "missing_artifact" : "invalid_artifact"
    }
    entries.push(entry)
  }
  const groups: EvalReport["groups"] = []
  for (const entry of entries) {
    const role = entry.role ?? "routing_control"
    if (
      groups.some(
        (g) =>
          g.role === role &&
          g.variant === entry.variant &&
          g.kind === entry.kind &&
          g.experiment === entry.experiment &&
          g.effort === entry.effort
      )
    )
      continue
    const matching = entries.filter(
      (e) =>
        (e.role ?? "routing_control") === role &&
        e.variant === entry.variant &&
        e.kind === entry.kind &&
        e.experiment === entry.experiment &&
        e.effort === entry.effort
    )
    const completed = matching.filter((e) => e.status === "completed")
    const scores = completed.flatMap((e) =>
      e.evaluation?.rubric === null || e.evaluation?.rubric === undefined
        ? []
        : Object.values(e.evaluation.rubric).map((r) => r.score)
    )
    groups.push({
      role,
      variant: entry.variant,
      kind: entry.kind,
      experiment: entry.experiment,
      effort: entry.effort,
      planned: matching.length,
      completed: completed.length,
      elapsed_ms: statistics(
        completed.flatMap((e) => (e.elapsed_ms === null ? [] : [e.elapsed_ms]))
      ),
      model_calls: statistics(
        completed.flatMap((e) =>
          e.model_calls === null ? [] : [e.model_calls]
        )
      ),
      tool_calls: statistics(
        completed.flatMap((e) => (e.tool_calls === null ? [] : [e.tool_calls]))
      ),
      numerical: matching.some((e) => e.evaluation === null)
        ? null
        : matching.reduce(
            (totals, e) => ({
              checked: totals.checked + (e.evaluation?.numerical.checked ?? 0),
              verified:
                totals.verified + (e.evaluation?.numerical.verified ?? 0),
              mismatch:
                totals.mismatch + (e.evaluation?.numerical.mismatch ?? 0),
              unresolved:
                totals.unresolved + (e.evaluation?.numerical.unresolved ?? 0),
              unchecked:
                totals.unchecked + (e.evaluation?.numerical.unchecked ?? 0),
              uncited: totals.uncited + (e.evaluation?.numerical.uncited ?? 0),
            }),
            {
              checked: 0,
              verified: 0,
              mismatch: 0,
              unresolved: 0,
              unchecked: 0,
              uncited: 0,
            }
          ),
      estimated_cost: matching.some((e) => e.estimated_cost === null)
        ? null
        : matching.reduce((sum, e) => sum + (e.estimated_cost ?? 0), 0),
      rubric_mean:
        scores.length === 0
          ? null
          : scores.reduce<number>((sum, v) => sum + v, 0) / scores.length,
      rubric_dimensions: Object.fromEntries(
        RUBRIC_DIMENSIONS.map((dimension) => {
          const values = completed.flatMap((e) => {
            const rating = e.evaluation?.rubric?.[dimension]
            return rating === undefined ? [] : [rating.score]
          })
          return [
            dimension,
            values.length === 0
              ? null
              : values.reduce<number>((sum, v) => sum + v, 0) / values.length,
          ]
        })
      ),
      scope_errors: matching.filter(
        (e) => e.evaluation?.semantic.scope.status === "fail"
      ).length,
      usage: Object.fromEntries(
        USAGE_CATEGORIES.map((category) => {
          const values = matching.map((e) => e.usage?.[category] ?? null)
          return [
            category,
            values.some((v) => v === null)
              ? null
              : values.reduce<number>((sum, v) => sum + (v ?? 0), 0),
          ]
        })
      ),
    })
  }
  const complete = entries.every(
    (e) => e.status === "completed" && e.evaluation !== null
  )
  const playbooks = entries.filter(
    (e) => e.variant === "playbook" && e.experiment === "roles"
  )
  const failed =
    playbooks.some(
      (e) =>
        e.status !== "completed" ||
        e.evaluation?.product_status === "fail" ||
        Object.values(e.evaluation?.rubric ?? {}).some((r) => r.score === 0)
    ) ||
    groups.some(
      (g) =>
        g.variant === "playbook" &&
        g.experiment === "roles" &&
        g.kind === "role_answer" &&
        g.rubric_mean !== null &&
        g.rubric_mean < 1.5
    )
  const pending = entries.some(
    (e) =>
      e.evaluation === null ||
      e.evaluation.product_status === "unknown" ||
      (e.kind === "role_answer" && e.evaluation.rubric === null)
  )
  return reportSchema.parse({
    schema_version: EVAL_VERSION,
    round_id: manifest.round_id,
    split: manifest.split,
    evaluator_version: evaluatorVersion,
    evaluator_sha256: digest(
      await Promise.all(
        ["evaluate.ts", "report.ts", "contracts.ts"].map((file) =>
          readFile(new URL(file, import.meta.url), "utf8")
        )
      )
    ),
    manifest_sha256: digest(manifest),
    assessments_sha256: digest(parsedAssessments),
    measurement_complete: complete,
    acceptance:
      manifest.fixture_only || !complete || pending
        ? "not_demonstrated"
        : failed
          ? "failed"
          : "pending_external_acceptance",
    limitations: [
      "No holdout acceptance is established by a development report.",
      "S-13 client evidence and human spot-check remain external acceptance gates.",
      ...(manifest.fixture_only
        ? ["Fixture metadata tests the evaluator; it is not corpus evidence."]
        : []),
      ...(manifest.pricing === null
        ? ["Pricing is unknown; no API cost is estimated."]
        : []),
    ],
    attempts: entries,
    groups,
    repetitions: manifest.repeated_questions.flatMap((question_id) =>
      (["baseline", "playbook"] as const).map((variant) => {
        const matching = entries.filter(
          (e) =>
            e.question_id === question_id &&
            e.variant === variant &&
            e.experiment === "roles"
        )
        return {
          question_id,
          variant,
          attempt_ids: matching.map((e) => e.attempt_id),
          elapsed_ms: statistics(
            matching
              .filter((e) => e.status === "completed")
              .flatMap((e) => (e.elapsed_ms === null ? [] : [e.elapsed_ms]))
          ),
          model_calls: statistics(
            matching.flatMap((e) =>
              e.model_calls === null ? [] : [e.model_calls]
            )
          ),
          tool_calls: statistics(
            matching.flatMap((e) =>
              e.tool_calls === null ? [] : [e.tool_calls]
            )
          ),
          estimated_cost: statistics(
            matching.flatMap((e) =>
              e.estimated_cost === null ? [] : [e.estimated_cost]
            )
          ),
          usage: Object.fromEntries(
            USAGE_CATEGORIES.map((category) => [
              category,
              statistics(
                matching.flatMap((e) => {
                  const value = e.usage?.[category]
                  return typeof value === "number" ? [value] : []
                })
              ),
            ])
          ),
        }
      })
    ),
    assessment_usage: null,
    assessment_cost: null,
  })
}
/** New reviewer versions are append-only; originals can never be overwritten. */
export async function saveReport(
  dir: string,
  version: string,
  assessments: SemanticAssessment[] = []
): Promise<EvalReport> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(version))
    throw new Error("Invalid evaluator version")
  const report = await recomputeReport(dir, version, assessments)
  await writeArtifact(dir, `assessments/${version}.json`, assessments)
  await writeArtifact(dir, `reports/${version}.json`, report)
  return report
}
