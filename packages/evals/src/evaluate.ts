import type { RunRecord } from "@workspace/agent/ai-sdk"
import {
  answerFindings,
  detectSections,
  extractCitations,
  findUncited,
  gateFindingSchema,
  type GateFinding,
  type SubmittedCheck,
} from "@workspace/domain/answer"
import type { Receipt } from "@workspace/domain/receipt"
import { checkClaimsOutputSchema } from "@workspace/domain/tools/check-claims"
import { z } from "zod"

import type { EvalQuestion } from "./contracts.ts"

export const assessmentStatusSchema = z.enum([
  "pass",
  "fail",
  "unknown",
  "not_applicable",
])
const assessmentSchema = z.strictObject({
  status: assessmentStatusSchema,
  reason: z.string().min(1),
})
const evidenceAssessmentSchema = assessmentSchema.extend({
  requirement: z.string().min(1),
  receipt_ids: z.array(z.string()),
})
const recommendationCheckSchema = assessmentSchema.extend({
  check_sequence: z.number().int().positive().nullable(),
  recommendation_after_sequence: z.number().int().nonnegative().nullable(),
})
const semanticDimensionsSchema = z.strictObject({
  scope: assessmentSchema,
  top_n_generalization: assessmentSchema,
  out_of_span_zero: assessmentSchema,
  denominator: assessmentSchema,
  precursor_causality: assessmentSchema,
  claim_alignment: assessmentSchema,
})
const rubricDimensionSchema = z.strictObject({
  score: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  reason: z.string().min(1),
})
const rubricSchema = z.strictObject({
  scope: rubricDimensionSchema,
  evidence: rubricDimensionSchema,
  action: rubricDimensionSchema,
  decision_check: rubricDimensionSchema,
  causal_separation: rubricDimensionSchema,
})
const reviewerSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["human", "agent"]),
  version: z.string().min(1),
  independent_of_playbooks: z.literal(true),
})

/**
 * An independent reviewer supplies semantic judgments. Neither headings nor a
 * successful numerical check establish scope, a denominator, or a causal claim.
 * Independence is a recorded reviewer declaration, never inferred by code.
 * Ratings are bound to one attempt; optional rubric scores belong to LOG-53.
 */
export const semanticAssessmentSchema = z.strictObject({
  question_id: z.string().min(1),
  run_id: z.string().min(1),
  assessed_at: z.iso.datetime(),
  reviewer: reviewerSchema,
  dimensions: semanticDimensionsSchema,
  required_evidence: z.array(evidenceAssessmentSchema),
  recommendation_check: recommendationCheckSchema,
  routing_control: assessmentSchema.optional(),
  rubric: rubricSchema.optional(),
})
export type SemanticAssessment = z.infer<typeof semanticAssessmentSchema>
type Assessment = z.infer<typeof assessmentSchema>
type EvidenceAssessment = z.infer<typeof evidenceAssessmentSchema>
type RecommendationCheck = z.infer<typeof recommendationCheckSchema>

const statusSchema = z.enum(["pass", "fail", "unknown"])
const count = z.number().int().nonnegative()
const sectionsSchema = z.strictObject({
  present: z.array(z.string()),
  missing: z.array(
    z.strictObject({ section: z.string(), part: z.enum(["frame", "core"]) })
  ),
})

export const evaluationSchema = z.strictObject({
  question_id: z.string(),
  run_id: z.string(),
  kind: z.enum(["role_answer", "routing_control"]),
  product_status: statusSchema,
  numerical: z.strictObject({
    status: statusSchema,
    // These are submission totals, including earlier failed submissions. Final
    // answer findings use the domain's latest-result-per-fact policy instead.
    checked: count,
    verified: count,
    mismatch: count,
    unresolved: count,
    unchecked: count,
    uncited: count,
    checks: z.array(z.string()),
    unavailable_checks: z.array(z.string()),
  }),
  findings: z.array(gateFindingSchema),
  sections: sectionsSchema,
  tool_choice: z.strictObject({
    status: statusSchema,
    observed: z.array(z.string()),
    matched_sequence: z.array(z.string()).nullable(),
  }),
  required_evidence: z.array(evidenceAssessmentSchema),
  recommendation_check: recommendationCheckSchema,
  semantic: semanticDimensionsSchema,
  routing_control: assessmentSchema.nullable(),
  unavailable_receipts: z.array(z.string()),
  reviewer: reviewerSchema.nullable(),
  assessed_at: z.iso.datetime().nullable(),
  rubric: rubricSchema.nullable(),
})
export type Evaluation = z.infer<typeof evaluationSchema>

function unknown(reason: string): Assessment {
  return { status: "unknown", reason }
}

function combine(
  statuses: readonly Assessment["status"][]
): Evaluation["product_status"] {
  if (statuses.includes("fail")) return "fail"
  if (statuses.includes("unknown")) return "unknown"
  return "pass"
}

function defaultDimensions(): z.infer<typeof semanticDimensionsSchema> {
  return {
    scope: unknown(
      "The answer's stated scope has not been independently assessed."
    ),
    top_n_generalization: unknown(
      "Generalization beyond top-N evidence has not been assessed."
    ),
    out_of_span_zero: unknown(
      "Zero claims outside dataset spans have not been assessed."
    ),
    denominator: unknown(
      "Rate numerators and denominators have not been assessed."
    ),
    precursor_causality: unknown(
      "Observation, hypothesis and precursor causality have not been assessed."
    ),
    claim_alignment: unknown(
      "Final numerical statements have not been independently mapped to the submitted claims; matching citation IDs alone cannot establish this."
    ),
  }
}

/** Only saved check_claims outputs are numerical authority; summaries are not. */
function readChecks(
  record: RunRecord,
  receipts: ReadonlyMap<string, Receipt>
): {
  checks: SubmittedCheck[]
  unavailable: string[]
} {
  const checks: SubmittedCheck[] = []
  const unavailable: string[] = []
  for (const check of record.check_claims) {
    const receipt = receipts.get(check.receipt_id)
    const output = checkClaimsOutputSchema.safeParse(receipt?.result)
    if (receipt?.tool !== "check_claims" || !output.success) {
      unavailable.push(check.receipt_id)
      continue
    }
    checks.push({ receipt_id: receipt.receipt_id, output: output.data })
  }
  return { checks, unavailable }
}

/**
 * domain/answer intentionally returns just no_check before any call. Offline
 * evaluation still inspects the complete introduction, tables, hypotheses,
 * Unknown and confirmation criteria. This uses the same canonical markings.
 */
function completeFindings(
  text: string,
  question: EvalQuestion,
  checks: SubmittedCheck[]
): GateFinding[] {
  const role = question.effective_role
  const findings = answerFindings({ text, role, checks })
  if (checks.length === 0) {
    for (const citation of extractCitations(text)) {
      if (citation.kind !== "fact") continue
      findings.push({
        kind: "unchecked",
        fact: citation.id,
        start: citation.start,
        end: citation.end,
        excerpt: text.slice(
          Math.max(0, citation.start - 60),
          citation.end + 60
        ),
      })
    }
    findings.push(
      ...findUncited(text).map((number) => ({
        kind: "uncited" as const,
        ...number,
      }))
    )
    findings.push(
      ...detectSections(text, role).missing.map((missing) => ({
        kind: "missing_section" as const,
        ...missing,
      }))
    )
  }
  return question.kind === "routing_control"
    ? findings.filter(
        (finding) =>
          finding.kind !== "missing_section" &&
          (finding.kind !== "no_check" ||
            extractCitations(text).some(
              (citation) => citation.kind === "fact"
            ) ||
            findUncited(text).length > 0)
      )
    : findings
}

function containsSequence(
  observed: readonly string[],
  required: readonly string[]
): boolean {
  let next = 0
  for (const tool of observed) {
    if (tool === required[next]) next += 1
  }
  return next === required.length
}

function evaluateEvidence(
  question: EvalQuestion,
  record: RunRecord,
  receipts: ReadonlyMap<string, Receipt>,
  assessment: SemanticAssessment | undefined
): EvidenceAssessment[] {
  const successful = new Set(
    record.phases
      .flatMap((phase) => phase.steps)
      .filter((step) => step.error_kind === null)
      .map((step) => step.receipt_id)
  )
  return question.required_evidence.map((requirement) => {
    const rated = assessment?.required_evidence.find(
      (item) => item.requirement === requirement
    )
    if (rated === undefined)
      return {
        requirement,
        ...unknown("Required evidence has not been independently assessed."),
        receipt_ids: [],
      }
    if (rated.status !== "pass") return rated
    const inaccessible = rated.receipt_ids.filter(
      (id) => !receipts.has(id) || !successful.has(id)
    )
    return inaccessible.length === 0
      ? rated
      : {
          ...rated,
          ...unknown(
            `Evidence receipts are unavailable or not linked to a successful run step: ${inaccessible.join(", ")}.`
          ),
        }
  })
}

function evaluateRecommendation(
  record: RunRecord,
  receipts: ReadonlyMap<string, Receipt>,
  rated: RecommendationCheck | undefined
): RecommendationCheck {
  const absent = (reason: string): RecommendationCheck => ({
    ...unknown(reason),
    check_sequence: rated?.check_sequence ?? null,
    recommendation_after_sequence: rated?.recommendation_after_sequence ?? null,
  })
  if (rated === undefined)
    return absent(
      "An independent reviewer must identify the distinguishing check and first recommendation."
    )
  if (rated.status === "fail" || rated.status === "unknown") return rated
  if (
    record.answer_versions === undefined ||
    record.answer_versions.length === 0
  ) {
    return absent(
      "No saved answer emission trace is available, including for a not-applicable recommendation rating."
    )
  }
  if (rated.status !== "pass") return rated
  const {
    check_sequence: checkSequence,
    recommendation_after_sequence: recommendationSequence,
  } = rated
  if (checkSequence === null || recommendationSequence === null)
    return absent(
      "The distinguishing check or recommendation has no chronological trace binding."
    )
  const step = record.phases
    .flatMap((phase) => phase.steps)
    .find((item) => item.sequence === checkSequence)
  const version = record.answer_versions?.find(
    (item) => item.after_sequence === recommendationSequence
  )
  if (
    step === undefined ||
    version === undefined ||
    step.started_at === undefined ||
    step.finished_at === undefined ||
    step.receipt_id === null ||
    !receipts.has(step.receipt_id)
  ) {
    return absent(
      "Saved successful check and answer emission trace are required to verify ordering."
    )
  }
  if (
    step.error_kind !== null ||
    step.tool === "check_claims" ||
    step.tool === "describe_corpus"
  ) {
    return {
      ...rated,
      status: "fail",
      reason:
        "The bound step is not a successful analytical distinguishing check.",
    }
  }
  if (
    version.completed_sequences !== undefined &&
    !version.completed_sequences.includes(checkSequence)
  ) {
    return {
      ...rated,
      status: "fail",
      reason:
        "The distinguishing check was not completed before recommendation text began.",
    }
  }
  const finished = Date.parse(step.finished_at)
  const emitted = Date.parse(version.started_at)
  if (!Number.isFinite(finished) || !Number.isFinite(emitted))
    return absent("Trace timestamps are not parseable.")
  if (version.completed_sequences === undefined && finished === emitted)
    return absent(
      "Millisecond timestamps tie and the legacy trace has no exact completed-sequence boundary."
    )
  if (checkSequence > recommendationSequence || finished > emitted) {
    return {
      ...rated,
      status: "fail",
      reason:
        "The distinguishing check completed after recommendation text began.",
    }
  }
  return rated
}

/**
 * Offline, deterministic inspection of an attempt plus optional independent
 * semantic ratings. No model calls, SQL, corpus arithmetic or numerical
 * comparator. A syntactically clean answer without semantic ratings is unknown.
 */
export function evaluateAttempt(input: {
  question: EvalQuestion
  record: RunRecord
  receipts: Receipt[]
  semanticAssessment?: SemanticAssessment
}): Evaluation {
  const { question, record } = input
  const assessment =
    input.semanticAssessment === undefined
      ? undefined
      : semanticAssessmentSchema.parse(input.semanticAssessment)
  if (
    assessment !== undefined &&
    (assessment.question_id !== question.id ||
      assessment.run_id !== record.run_id)
  ) {
    throw new Error("Semantic assessment belongs to a different attempt.")
  }
  const saved = new Map(
    input.receipts.map((receipt) => [receipt.receipt_id, receipt])
  )
  const { checks, unavailable } = readChecks(record, saved)
  const text = record.final_text ?? ""
  const findings = completeFindings(text, question, checks)
  // The live domain gate exempts facts from a check's own receipt to avoid
  // recursively checking its summary. Offline we have the full saved receipt:
  // only existing summary facts qualify for that exemption. This checks ID
  // membership, never a numerical value, metric, or group.
  const checkIds = new Set(checks.map((check) => check.receipt_id))
  for (const citation of extractCitations(text)) {
    if (citation.kind !== "fact" || !checkIds.has(citation.receiptId)) continue
    if (
      saved
        .get(citation.receiptId)
        ?.facts.some((fact) => fact.id === citation.id)
    )
      continue
    if (
      findings.some(
        (finding) =>
          finding.kind === "unchecked" && finding.start === citation.start
      )
    )
      continue
    findings.push({
      kind: "unchecked",
      fact: citation.id,
      start: citation.start,
      end: citation.end,
      excerpt: text.slice(Math.max(0, citation.start - 60), citation.end + 60),
    })
  }
  const sections =
    question.kind === "routing_control"
      ? { present: [], missing: [] }
      : detectSections(text, question.effective_role)
  const successful = record.phases
    .flatMap((phase) => phase.steps)
    .filter((step) => step.error_kind === null)
  const observed = successful.map((step) => step.tool)
  const matched = question.allowed_tool_sequences.find((sequence) =>
    question.kind === "routing_control"
      ? sequence.length === observed.length &&
        sequence.every((tool, index) => tool === observed[index])
      : containsSequence(observed, sequence)
  )
  const toolChoice = {
    status: matched === undefined ? ("fail" as const) : ("pass" as const),
    observed,
    matched_sequence: matched ?? null,
  }
  const requiredEvidence = evaluateEvidence(question, record, saved, assessment)
  const recommendation = evaluateRecommendation(
    record,
    saved,
    assessment?.recommendation_check
  )
  const semantic =
    assessment === undefined
      ? defaultDimensions()
      : { ...assessment.dimensions }
  const unavailableReceipts = [
    ...new Set(
      extractCitations(text)
        .map((citation) => citation.receiptId)
        .filter((id) => !saved.has(id))
    ),
  ]
  if (semantic.scope.status === "pass" && unavailableReceipts.length > 0) {
    semantic.scope = unknown(
      `Cited source receipt scopes are unavailable: ${unavailableReceipts.join(", ")}.`
    )
  }
  const counts = checks.reduce(
    (totals, check) => ({
      checked: totals.checked + check.output.summary.checked,
      verified: totals.verified + check.output.summary.verified,
      mismatch: totals.mismatch + check.output.summary.mismatch,
      unresolved: totals.unresolved + check.output.summary.unresolved,
    }),
    { checked: 0, verified: 0, mismatch: 0, unresolved: 0 }
  )
  const unchecked = findings.filter(
    (finding) => finding.kind === "unchecked"
  ).length
  const uncited = findings.filter(
    (finding) => finding.kind === "uncited"
  ).length
  const numericalFailure = findings.some((finding) =>
    ["mismatch", "unresolved", "unchecked", "uncited"].includes(finding.kind)
  )
  const noCheck = findings.some((finding) => finding.kind === "no_check")
  const numericalStatus = numericalFailure
    ? "fail"
    : unavailable.length > 0
      ? "unknown"
      : noCheck
        ? "fail"
        : "pass"
  const routing =
    question.kind === "routing_control"
      ? (assessment?.routing_control ??
        unknown(
          "Routing and absence of analytical recommendations have not been independently assessed."
        ))
      : null
  const statuses: Assessment["status"][] = [
    numericalStatus,
    toolChoice.status,
    record.status === "completed" && record.final_text !== null
      ? "pass"
      : "fail",
    ...requiredEvidence.map((item) => item.status),
  ]
  if (question.kind === "routing_control")
    statuses.push(routing?.status ?? "unknown")
  else
    statuses.push(
      sections.missing.length === 0 ? "pass" : "fail",
      recommendation.status,
      ...Object.values(semantic).map((item) => item.status)
    )
  return evaluationSchema.parse({
    question_id: question.id,
    run_id: record.run_id,
    kind: question.kind,
    product_status: combine(statuses),
    numerical: {
      status: numericalStatus,
      ...counts,
      unchecked,
      uncited,
      checks: checks.map((check) => check.receipt_id),
      unavailable_checks: unavailable,
    },
    findings,
    sections,
    tool_choice: toolChoice,
    required_evidence: requiredEvidence,
    recommendation_check: recommendation,
    semantic,
    routing_control: routing,
    unavailable_receipts: unavailableReceipts,
    reviewer: assessment?.reviewer ?? null,
    assessed_at: assessment?.assessed_at ?? null,
    rubric: assessment?.rubric ?? null,
  })
}
