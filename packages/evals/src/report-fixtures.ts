import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runRecordSchema } from "@workspace/agent/ai-sdk"
import { receiptSchema } from "@workspace/domain/receipt"
import type { ReceiptStore } from "@workspace/domain/tool"
import { checkClaimsOutputSchema } from "@workspace/domain/tools/check-claims"
import { digest, exportAttempt, writeArtifact } from "./artifacts.ts"
import {
  EVAL_VERSION,
  attemptSchema,
  makePlan,
  manifestSchema,
  questionBankSchema,
  type EvalAttempt,
  type EvalManifest,
} from "./contracts.ts"
import { semanticAssessmentSchema } from "./evaluate.ts"

// Hand-authored synthetic inputs exercise the nonfixture acceptance branch.
// They establish artifact/report behavior only, never live or corpus quality.
const roles = ["engineer", "team_lead", "manager"] as const
const bank = questionBankSchema.parse({
  version: 2,
  reference_data_version: "synthetic-report-control",
  reference_status: "historical_unverified",
  reference_provenance: [
    "Hand-authored report regression inputs, not corpus evidence.",
  ],
  questions: [
    ...roles.flatMap((role) =>
      [1, 2, 3, 4].map((index) => ({
        id: `control-${role}-${index}`,
        kind: "role_answer",
        role: index === 4 ? null : role,
        effective_role: role,
        covers: ["S-06", "S-07", "S-10", "S-14", "S-15", "S-16"],
        question:
          "Inspect the saved calibration count and suggest a next check.",
        scope: { dataset: "bgl" },
        required_evidence: ["A saved scoped calibration count."],
        distinguishing_check:
          "Read the scoped count before recommending context inspection.",
        allowed_tool_sequences: [["count_events", "check_claims"]],
      }))
    ),
    {
      id: "control-routing",
      kind: "routing_control",
      role: null,
      effective_role: null,
      covers: [],
      question: "Which perspective is needed after the saved claim check?",
      scope: {},
      required_evidence: ["Ask which perspective the user needs."],
      distinguishing_check: "Ask for the intended perspective.",
      allowed_tool_sequences: [["check_claims"]],
    },
  ],
})
const scope = {
  windows: [
    {
      dataset: "bgl",
      from: "2005-06-01T00:00:00Z",
      to: "2005-07-01T00:00:00Z",
    },
  ],
  filters: {},
}
const check = checkClaimsOutputSchema.parse({
  claims: [
    {
      claim: { fact: "r_11111111.f1", value: 12, metric: "events", group: {} },
      status: "verified",
      mismatch_on: [],
      reason: null,
      fact: { value: 12, metric: "events", unit: "log_events", group: {} },
      receipt: {
        receipt_id: "r_11111111",
        tool: "count_events",
        data_version: "dv_reportcontrol",
        scope,
      },
    },
  ],
  summary: {
    checked: 1,
    verified: 1,
    mismatch: 0,
    unresolved: 0,
    text: "Independent synthetic check result.",
  },
})
const receiptBase = {
  created_at: "2026-10-18T10:00:01Z",
  client: "eval",
  tool_version: "control",
  input: {},
  signature: "0".repeat(64),
  data_version: "dv_reportcontrol",
  sql: [],
  params: [],
  scope,
  population: null,
  rows_returned: 1,
  truncated: false,
  row_limit: null,
  duration_ms: 1000,
}
export const sourceReceipt = receiptSchema.parse({
  ...receiptBase,
  receipt_id: "r_11111111",
  tool: "count_events",
  result: { events: 12 },
  result_digest: digest({ events: 12 }),
  facts: [
    {
      id: "r_11111111.f1",
      path: "/result/events",
      value: 12,
      metric: "events",
      unit: "log_events",
      group: {},
    },
  ],
})
export const checkReceipt = receiptSchema.parse({
  ...receiptBase,
  receipt_id: "r_22222222",
  tool: "check_claims",
  result: check,
  result_digest: digest(check),
  facts: [],
})
const receipts = [sourceReceipt, checkReceipt]
export const controlReceiptStore: ReceiptStore = {
  put: () => {
    throw new Error("Read-only control store")
  },
  get: (id) =>
    Promise.resolve(
      receipts.find((receipt) => receipt.receipt_id === id) ?? null
    ),
  list: () => Promise.resolve(receipts.map((receipt) => receipt.receipt_id)),
}
const core = {
  engineer: ["Evidence", "Timeline", "Narrowing", "Hypotheses", "Next check"],
  team_lead: [
    "Recurring patterns",
    "Recurring vs. one-off",
    "Investigate first",
    "Improvement",
  ],
  manager: [
    "Priorities",
    "Why this order",
    "Decision needed",
    "Missing information",
  ],
}
const passed = {
  status: "pass",
  reason: "Independent hand-authored calibration assessment.",
}
const score = {
  score: 2,
  reason: "Independent hand-authored calibration rubric.",
}

export const knownPricing: NonNullable<EvalManifest["pricing"]> = {
  model_id: "offline-report-control",
  currency: "USD",
  date: "2026-10-18",
  url: "https://example.com/synthetic-pricing",
  input_per_million: 10,
  output_per_million: 50,
  cache_read_per_million: 2,
  cache_write_per_million: 5,
}
export async function savedRound(
  dir: string,
  pricing: EvalManifest["pricing"] = null
) {
  const instructions = { control: "Synthetic frozen report instructions." },
    toolCatalog: [] = []
  const manifest = manifestSchema.parse({
    schema_version: EVAL_VERSION,
    round_id: "report-control",
    created_at: "2026-10-18T10:00:00Z",
    split: "development",
    fixture_only: false,
    versions: {
      code_commit: "offline-control",
      code_dirty: false,
      code_sha256: digest("control"),
      questions_sha256: digest(bank),
      tools_sha256: digest(toolCatalog),
      prompts_sha256: digest(instructions),
      rubric_version: "control",
      rubric_sha256: digest("control"),
      data_version: "dv_reportcontrol",
    },
    model: {
      id: "offline-report-control",
      effort: "high",
      provider_options: {},
    },
    limits: {
      max_steps: 10,
      max_follow_ups: 1,
      max_revisions: 1,
      timeout_ms: 10000,
      max_retries: 0,
      output_limit: null,
      context_limit: null,
    },
    initial_history: "empty",
    pricing,
    instructions,
    tool_catalog: toolCatalog,
    repeated_questions: roles.map((role) => `control-${role}-1`),
    attempts: makePlan(
      bank,
      roles.map((role) => `control-${role}-1`)
    ),
  })
  await writeArtifact(dir, "manifest.json", manifest)
  await writeArtifact(dir, "questions.json", bank)
  const assessments = []
  for (const plan of manifest.attempts) {
    const question = bank.questions.find((item) => item.id === plan.question_id)
    if (question === undefined) throw new Error("Missing control question")
    const role = question.effective_role
    const text =
      role === null
        ? "Which perspective do you need: diagnosis, team review, or resource allocation?"
        : [
            "## Scope\nBGL within the saved calibration scope.",
            "## Answer\n12 events [r_11111111.f1].",
            ...core[role].map(
              (heading) =>
                `## ${heading}\nInspect component context next; the cause remains unknown.`
            ),
            "## Unknown\nBusiness impact and cause remain unknown.",
            "## Verification\nThe saved check verified the submitted claim.",
          ].join("\n")
    const allSteps = [
      {
        sequence: 1,
        tool: "count_events",
        receipt_id: sourceReceipt.receipt_id,
        started_at: "2026-10-18T10:00:00Z",
        finished_at: "2026-10-18T10:00:01Z",
        input: { dataset: "bgl" },
        duration_ms: 1000,
        error_kind: null,
      },
      {
        sequence: 2,
        tool: "check_claims",
        receipt_id: checkReceipt.receipt_id,
        started_at: "2026-10-18T10:00:01Z",
        finished_at: "2026-10-18T10:00:02Z",
        input: { claims: [] },
        duration_ms: 1000,
        error_kind: null,
      },
    ]
    const record = runRecordSchema.parse({
      run_id: `run_${plan.order.toString(16).padStart(8, "0")}`,
      started_at: "2026-10-18T10:00:00Z",
      finished_at: "2026-10-18T10:00:03Z",
      duration_ms: 3000,
      status: "completed",
      variant: plan.variant,
      role: { requested: question.role ?? "auto", effective: role ?? "auto" },
      question: question.question,
      scope: question.scope,
      model_id: manifest.model.id,
      effort: manifest.model.effort,
      guidance_version: "control",
      contract_version: "control",
      data_version: manifest.versions.data_version,
      instruction_texts: [],
      phases: [
        {
          kind: "investigate",
          steps: role === null ? allSteps.slice(1) : allSteps,
        },
      ],
      answer_versions: [
        {
          text,
          phase: "answer",
          started_at: "2026-10-18T10:00:02Z",
          completed_at: "2026-10-18T10:00:03Z",
          after_sequence: 2,
          completed_sequences: role === null ? [2] : [1, 2],
        },
      ],
      coverage_requests: [],
      gate_findings: [[]],
      usage: { input: 100, output: 20, cache_read: 20, cache_write: 10 },
      model_calls: 1,
      final_text: text,
      check_claims: [
        { receipt_id: checkReceipt.receipt_id, summary: { checked: 1 } },
      ],
      error_kind: null,
    })
    await exportAttempt({
      dir,
      plan,
      record,
      receipts: controlReceiptStore,
      started_at: record.started_at,
      finished_at: record.finished_at,
      elapsed_ms: record.duration_ms,
    })
    assessments.push(
      semanticAssessmentSchema.parse({
        question_id: question.id,
        run_id: record.run_id,
        assessed_at: "2026-10-18T11:00:00Z",
        reviewer: {
          id: "independent-fixture-author",
          kind: "agent",
          version: "control",
          independent_of_playbooks: true,
        },
        dimensions: {
          scope: passed,
          top_n_generalization: passed,
          out_of_span_zero: passed,
          denominator: passed,
          precursor_causality: passed,
          claim_alignment: passed,
        },
        required_evidence: question.required_evidence.map((requirement) => ({
          requirement,
          ...passed,
          receipt_ids: role === null ? [] : [sourceReceipt.receipt_id],
        })),
        recommendation_check:
          role === null
            ? {
                status: "not_applicable",
                reason: "This control only asks for a perspective.",
                check_sequence: null,
                recommendation_after_sequence: null,
              }
            : {
                ...passed,
                check_sequence: 1,
                recommendation_after_sequence: 2,
              },
        routing_control: passed,
        rubric: {
          scope: score,
          evidence: score,
          action: score,
          decision_check: score,
          causal_separation: score,
        },
      })
    )
  }
  return { manifest, assessments }
}

export async function rewriteAttempt(
  dir: string,
  id: string,
  patch: Partial<EvalAttempt>
) {
  const path = join(dir, `attempts/${id}.json`)
  const attempt = attemptSchema.parse(JSON.parse(await readFile(path, "utf8")))
  await writeFile(
    path,
    JSON.stringify(attemptSchema.parse({ ...attempt, ...patch }))
  )
}
