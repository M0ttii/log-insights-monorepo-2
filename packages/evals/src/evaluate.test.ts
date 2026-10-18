import { runRecordSchema, type RunRecord } from "@workspace/agent/ai-sdk"
import { receiptSchema, type Receipt } from "@workspace/domain/receipt"
import { checkClaimsOutputSchema } from "@workspace/domain/tools/check-claims"
import { describe, expect, it } from "vitest"

import { questionSchema } from "./contracts.ts"
import {
  evaluateAttempt,
  semanticAssessmentSchema,
  type SemanticAssessment,
} from "./evaluate.ts"

// Deliberately synthetic evaluator inputs, never corpus findings or expected
// analytics values. The fixture's saved check_claims result is the numerical
// oracle; this evaluator must not implement a second value/metric/group checker.
const question = questionSchema.parse({
  id: "calibration-engineer",
  kind: "role_answer",
  role: "engineer",
  effective_role: "engineer",
  covers: ["S-07"],
  question: "What should we check next?",
  scope: { dataset: "bgl" },
  required_evidence: ["A scoped count from count_events"],
  distinguishing_check:
    "Run the scoped count before recommending a next check.",
  allowed_tool_sequences: [["count_events", "check_claims"]],
})

const answer = [
  "## Scope",
  "BGL, within the searched dataset span.",
  "## Answer",
  "12 events [r_11111111.f1].",
  "## Evidence",
  "The scoped count is available.",
  "## Timeline",
  "Timing is not established.",
  "## Narrowing",
  "This is the searched component only.",
  "## Hypotheses",
  "A shared origin remains open; the discriminating check is component context.",
  "## Next check",
  "Ask the owning team to inspect component context.",
  "## Unknown",
  "Business effect and cause remain unknown.",
  "## Verification",
  "The submitted numerical claim was checked.",
].join("\n")

function record(text = answer): RunRecord {
  return runRecordSchema.parse({
    run_id: "run_12345678",
    started_at: "2026-10-18T10:00:00Z",
    finished_at: "2026-10-18T10:00:03Z",
    duration_ms: 3000,
    status: "completed",
    variant: "playbook",
    role: { requested: "engineer", effective: "engineer" },
    question: question.question,
    scope: question.scope,
    model_id: "fixture-model",
    effort: "high",
    guidance_version: "fixture-guidance",
    contract_version: "fixture-contract",
    data_version: "fixture-only",
    instruction_texts: [],
    phases: [
      {
        kind: "investigate",
        steps: [
          {
            sequence: 1,
            started_at: "2026-10-18T10:00:00Z",
            finished_at: "2026-10-18T10:00:01Z",
            tool: "count_events",
            input: { dataset: "bgl" },
            receipt_id: "r_11111111",
            duration_ms: 1000,
            error_kind: null,
          },
          {
            sequence: 2,
            started_at: "2026-10-18T10:00:01Z",
            finished_at: "2026-10-18T10:00:02Z",
            tool: "check_claims",
            input: { claims: [] },
            receipt_id: "r_22222222",
            duration_ms: 1000,
            error_kind: null,
          },
        ],
      },
    ],
    answer_versions: [
      {
        text,
        phase: "answer",
        started_at: "2026-10-18T10:00:02Z",
        completed_at: "2026-10-18T10:00:03Z",
        after_sequence: 2,
        completed_sequences: [1, 2],
      },
    ],
    coverage_requests: [],
    gate_findings: [[]],
    usage: { input: null, output: null, cache_read: null, cache_write: null },
    final_text: text,
    check_claims: [{ receipt_id: "r_22222222", summary: { checked: 1 } }],
    error_kind: null,
  })
}

function receipts(
  status: "verified" | "mismatch" | "unknown_fact" = "verified",
  mismatchOn: ("value" | "metric" | "group")[] = []
): Receipt[] {
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
        claim: {
          fact: status === "unknown_fact" ? "r_11111111.f9" : "r_11111111.f1",
          value: mismatchOn.includes("value") ? 13 : 12,
          metric: mismatchOn.includes("metric") ? "requests" : "events",
          group: mismatchOn.includes("group") ? { team: "Other team" } : {},
        },
        status,
        mismatch_on: mismatchOn,
        reason:
          status === "verified" ? null : "Hand-authored calibration result.",
        fact:
          status === "unknown_fact"
            ? null
            : { value: 12, metric: "events", unit: "log_events", group: {} },
        receipt: {
          receipt_id: "r_11111111",
          tool: "count_events",
          data_version: "fixture-only",
          scope,
        },
      },
    ],
    summary: {
      checked: 1,
      verified: status === "verified" ? 1 : 0,
      mismatch: status === "mismatch" ? 1 : 0,
      unresolved: status === "unknown_fact" ? 1 : 0,
      text: "Hand-authored calibration counts.",
    },
  })
  const base = {
    created_at: "2026-10-18T10:00:01Z",
    client: "eval",
    tool_version: "fixture-only",
    input: {},
    signature: "0".repeat(64),
    data_version: "fixture-only",
    sql: [],
    params: [],
    scope,
    population: null,
    rows_returned: 1,
    truncated: false,
    row_limit: null,
    duration_ms: 1000,
    result_digest: "0".repeat(64),
    facts: [],
  }
  return [
    receiptSchema.parse({
      ...base,
      receipt_id: "r_11111111",
      tool: "count_events",
      result: { events: 12 },
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
    }),
    receiptSchema.parse({
      ...base,
      receipt_id: "r_22222222",
      tool: "check_claims",
      result: check,
      scope: { windows: [], filters: {} },
    }),
  ]
}

function assessment(): SemanticAssessment {
  const pass = { status: "pass", reason: "Independent fixture rating." }
  const irrelevant = {
    status: "not_applicable",
    reason: "This fixture makes no claim in this dimension.",
  }
  return semanticAssessmentSchema.parse({
    question_id: question.id,
    run_id: "run_12345678",
    assessed_at: "2026-10-18T11:00:00Z",
    reviewer: {
      id: "independent-calibration-reviewer",
      kind: "agent",
      version: "calibration-v1",
      independent_of_playbooks: true,
    },
    dimensions: {
      scope: pass,
      top_n_generalization: irrelevant,
      out_of_span_zero: irrelevant,
      denominator: irrelevant,
      precursor_causality: pass,
      claim_alignment: pass,
    },
    required_evidence: [
      {
        requirement: "A scoped count from count_events",
        ...pass,
        receipt_ids: ["r_11111111"],
      },
    ],
    recommendation_check: {
      ...pass,
      check_sequence: 1,
      recommendation_after_sequence: 2,
    },
  })
}

describe("offline evaluation", () => {
  it("keeps semantic scope unknown even when syntax and saved claim checks pass", () => {
    const result = evaluateAttempt({
      question,
      record: record(),
      receipts: receipts(),
    })
    expect(result.numerical).toMatchObject({
      status: "pass",
      checked: 1,
      verified: 1,
      mismatch: 0,
      unresolved: 0,
    })
    expect(result.semantic.scope.status).toBe("unknown")
    expect(result.product_status).toBe("unknown")
    expect(result.reviewer).toBeNull()
    expect(result.rubric).toBeNull()
  })

  it("passes the complete independently rated calibration control", () => {
    expect(
      evaluateAttempt({
        question,
        record: record(),
        receipts: receipts(),
        semanticAssessment: assessment(),
      }).product_status
    ).toBe("pass")
  })

  it("inspects the entire answer even when no check makes the domain gate short-circuit", () => {
    const input = record(
      `Introduction: 3 events.\n${answer}\n| Metric | Value |\n| count | 4 |\n## Unknown\n5 cases.\nConfirmation requires 6 examples.`
    )
    input.check_claims = []
    input.phases = []
    const result = evaluateAttempt({ question, record: input, receipts: [] })
    expect(result.findings.some((finding) => finding.kind === "no_check")).toBe(
      true
    )
    expect(result.numerical.unchecked).toBe(1)
    expect(
      result.findings
        .filter((finding) => finding.kind === "uncited")
        .map((finding) => finding.value)
    ).toEqual(["3", "4", "5", "6"])
    expect(result.numerical.status).toBe("fail")
  })

  it("reports missing role sections and required evidence independently", () => {
    const result = evaluateAttempt({
      question,
      record: record("## Answer\n12 events [r_11111111.f1]."),
      receipts: receipts(),
    })
    expect(result.sections.missing).toContainEqual({
      section: "Scope",
      part: "frame",
    })
    expect(result.sections.missing).toContainEqual({
      section: "Next check",
      part: "core",
    })
    expect(result.required_evidence[0]?.status).toBe("unknown")
    expect(result.product_status).toBe("fail")
  })

  it("never turns absent chronological trace into a successful check-before-recommendation", () => {
    const input = record()
    delete input.answer_versions
    const result = evaluateAttempt({
      question,
      record: input,
      receipts: receipts(),
      semanticAssessment: assessment(),
    })
    expect(result.recommendation_check.status).toBe("unknown")
    expect(result.product_status).toBe("unknown")
  })

  it("does not accept a role-answer N/A rating without saved answer trace", () => {
    const input = record()
    delete input.answer_versions
    const rating = assessment()
    rating.recommendation_check = {
      status: "not_applicable",
      reason: "This independently rated answer has no recommendation.",
      check_sequence: null,
      recommendation_after_sequence: null,
    }
    const result = evaluateAttempt({
      question,
      record: input,
      receipts: receipts(),
      semanticAssessment: rating,
    })
    expect(result.recommendation_check.status).toBe("unknown")
    expect(result.product_status).toBe("unknown")
  })

  it("preserves an independently rated failed check even when trace is unavailable", () => {
    const input = record()
    delete input.answer_versions
    const rating = assessment()
    rating.recommendation_check.status = "fail"
    rating.recommendation_check.reason =
      "The required check was omitted before the recommendation."
    const result = evaluateAttempt({
      question,
      record: input,
      receipts: receipts(),
      semanticAssessment: rating,
    })
    expect(result.recommendation_check.status).toBe("fail")
    expect(result.product_status).toBe("fail")
  })

  it("fails an actual check performed after the first recommendation", () => {
    const rating = assessment()
    rating.recommendation_check.recommendation_after_sequence = 0
    const input = record()
    if (input.answer_versions?.[0] !== undefined) {
      input.answer_versions[0].after_sequence = 0
      input.answer_versions[0].completed_sequences = []
    }
    const result = evaluateAttempt({
      question,
      record: input,
      receipts: receipts(),
      semanticAssessment: rating,
    })
    expect(result.recommendation_check.status).toBe("fail")
    expect(result.product_status).toBe("fail")
  })

  it("fails a slow earlier invocation that was still running when recommendation text began", () => {
    const input = record()
    if (input.answer_versions?.[0] !== undefined)
      input.answer_versions[0].completed_sequences = [2]
    const result = evaluateAttempt({
      question,
      record: input,
      receipts: receipts(),
      semanticAssessment: assessment(),
    })
    expect(result.recommendation_check.status).toBe("fail")
  })

  it("keeps inaccessible saved check results visible", () => {
    const result = evaluateAttempt({ question, record: record(), receipts: [] })
    expect(result.numerical.unavailable_checks).toEqual(["r_22222222"])
    expect(result.numerical.checked).toBe(0)
    expect(result.numerical.status).not.toBe("pass")
  })

  it("rejects a reviewer assessment from a different attempt", () => {
    const rating = assessment()
    rating.run_id = "run_87654321"
    expect(() =>
      evaluateAttempt({
        question,
        record: record(),
        receipts: receipts(),
        semanticAssessment: rating,
      })
    ).toThrow(/attempt/)
  })

  it("evaluates routing controls without demanding a full role answer", () => {
    const routing = questionSchema.parse({
      ...question,
      id: "calibration-routing",
      kind: "routing_control",
      role: null,
      effective_role: null,
      required_evidence: ["Clarify the user's goal before recommending."],
      allowed_tool_sequences: [[]],
    })
    const input = record(
      "Which perspective do you need: diagnosis, team review, or resource allocation?"
    )
    input.phases = []
    input.check_claims = []
    const rating = semanticAssessmentSchema.parse({
      ...assessment(),
      question_id: routing.id,
      required_evidence: [
        {
          requirement: routing.required_evidence[0],
          status: "pass",
          reason: "The answer asks for the perspective.",
          receipt_ids: [],
        },
      ],
      recommendation_check: {
        status: "not_applicable",
        reason: "No recommendation was emitted.",
        check_sequence: null,
        recommendation_after_sequence: null,
      },
      routing_control: {
        status: "pass",
        reason: "Goal is clarified without analytical recommendations.",
      },
    })
    const result = evaluateAttempt({
      question: routing,
      record: input,
      receipts: [],
      semanticAssessment: rating,
    })
    expect(result.sections.missing).toEqual([])
    expect(result.product_status).toBe("pass")
  })
})

describe("hand-authored calibration mutations", () => {
  it.each(["value", "metric", "group"] as const)(
    "retains check_claims %s mismatches without a second numerical comparator",
    (field) => {
      const mutated = answer.replace(
        "12 events",
        field === "value"
          ? "13 events"
          : field === "metric"
            ? "12 requests"
            : "12 events for Other team"
      )
      const result = evaluateAttempt({
        question,
        record: record(mutated),
        receipts: receipts("mismatch", [field]),
        semanticAssessment: assessment(),
      })
      expect(result.numerical.mismatch).toBe(1)
      expect(result.findings).toContainEqual(
        expect.objectContaining({ kind: "mismatch", mismatch_on: [field] })
      )
      expect(result.product_status).toBe("fail")
    }
  )

  it("retains unknown fact IDs as unresolved", () => {
    const result = evaluateAttempt({
      question,
      record: record(answer.replace("r_11111111.f1", "r_11111111.f9")),
      receipts: receipts("unknown_fact"),
      semanticAssessment: assessment(),
    })
    expect(result.numerical.unresolved).toBe(1)
    expect(result.product_status).toBe("fail")
  })

  it("finds a citation that was never submitted", () => {
    const result = evaluateAttempt({
      question,
      record: record(answer.replace("r_11111111.f1", "r_11111111.f2")),
      receipts: receipts(),
      semanticAssessment: assessment(),
    })
    expect(result.numerical.unchecked).toBe(1)
    expect(result.product_status).toBe("fail")
  })

  it("does not exempt a fabricated summary fact merely because its receipt was checked", () => {
    const result = evaluateAttempt({
      question,
      record: record(`${answer}\n0 unresolved [r_22222222.f999].`),
      receipts: receipts(),
      semanticAssessment: assessment(),
    })
    expect(result.numerical.unchecked).toBe(1)
    expect(result.product_status).toBe("fail")
  })

  it("accepts an existing check summary fact without recursively submitting it", () => {
    const saved = receipts()
    const summary = saved.find((item) => item.tool === "check_claims")
    if (summary === undefined) throw new Error("Missing summary receipt")
    summary.facts.push({
      id: "r_22222222.f1",
      path: "/result/summary/checked",
      value: 1,
      metric: "claims_checked",
      unit: "claims",
      group: {},
    })
    const result = evaluateAttempt({
      question,
      record: record(`${answer}\n1 checked claim [r_22222222.f1].`),
      receipts: saved,
      semanticAssessment: assessment(),
    })
    expect(result.numerical.unchecked).toBe(0)
    expect(result.product_status).toBe("pass")
  })

  it("does not claim that a reused fact ID proves an altered final numerical statement", () => {
    const rating = assessment()
    rating.dimensions.claim_alignment = {
      status: "fail",
      reason:
        "The final text states a different value from the submitted claim; the saved checker only checked the original submission.",
    }
    const result = evaluateAttempt({
      question,
      record: record(answer.replace("12 events", "13 events")),
      receipts: receipts(),
      semanticAssessment: rating,
    })
    expect(result.numerical.status).toBe("pass")
    expect(result.semantic.claim_alignment.status).toBe("fail")
    expect(result.product_status).toBe("fail")
  })

  it.each([
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "06:25",
    "37.5%",
  ])("finds the uncited token %s anywhere in prose", (token) => {
    const result = evaluateAttempt({
      question,
      record: record(`${answer}\nConfirmation requires ${token} examples.`),
      receipts: receipts(),
    })
    expect(result.findings).toContainEqual(
      expect.objectContaining({ kind: "uncited", value: token })
    )
  })

  it("does not flag list markers, identifiers, citation digits, or code as claims", () => {
    const text = `${answer}\n1. Inspect U26 and dat32k_060205.\n2. Read \`503\` and \`r_11111111.f9\`.\n\n\`\`\`text\n0 06:25 37.5%\n\`\`\``
    const result = evaluateAttempt({
      question,
      record: record(text),
      receipts: receipts(),
    })
    expect(result.numerical.uncited).toBe(0)
    expect(result.numerical.unchecked).toBe(0)
  })

  it.each([
    [
      "scope",
      "The same cited number belongs to a different time window.",
      "BGL, for the unsearched following month.",
    ],
    [
      "top_n_generalization",
      "The answer generalizes a truncated top-N list to all components.",
      "This top-N list proves that all components are affected.",
    ],
    [
      "out_of_span_zero",
      "The answer calls a bucket outside the dataset span zero.",
      "The bucket outside the dataset span had no events.",
    ],
    [
      "denominator",
      "The error rate uses requests instead of API accesses as denominator.",
      "Use unique requests as the denominator of this API-access error rate.",
    ],
    [
      "precursor_causality",
      "A temporal precursor is asserted to be the cause.",
      "The earlier login failure is proven to cause this later error.",
    ],
  ] as const)(
    "fails independent semantic %s mutation despite verified numbers",
    (dimension, reason, mutatedStatement) => {
      const rating = assessment()
      rating.dimensions[dimension] = { status: "fail", reason }
      const result = evaluateAttempt({
        question,
        record: record(`${mutatedStatement}\n${answer}`),
        receipts: receipts(),
        semanticAssessment: rating,
      })
      expect(result.numerical.status).toBe("pass")
      expect(result.semantic[dimension]).toEqual({ status: "fail", reason })
      expect(result.product_status).toBe("fail")
    }
  )

  it("accepts an independently rated zero and an open hypothesis", () => {
    const saved = receipts()
    const checkReceipt = saved.find((item) => item.tool === "check_claims")
    if (checkReceipt === undefined)
      throw new Error("Missing calibration check receipt")
    const output = checkClaimsOutputSchema.parse(checkReceipt.result)
    const claim = output.claims[0]
    if (claim === undefined || claim.fact === null)
      throw new Error("Missing calibration fact")
    claim.claim.value = 0
    claim.fact.value = 0
    checkReceipt.result = output
    const source = saved.find((item) => item.tool === "count_events")
    const fact = source?.facts[0]
    if (source === undefined || fact === undefined)
      throw new Error("Missing calibration source fact")
    source.result = { events: 0 }
    fact.value = 0
    const result = evaluateAttempt({
      question,
      record: record(answer.replace("12 events", "0 events")),
      receipts: saved,
      semanticAssessment: assessment(),
    })
    expect(result.product_status).toBe("pass")
    expect(result.semantic.precursor_causality.status).toBe("pass")
  })
})
