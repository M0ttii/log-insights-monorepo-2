import { runRecordSchema } from "@workspace/agent/ai-sdk"
import { canonicalJson, receiptSchema } from "@workspace/domain/receipt"
import { describe, expect, it } from "vitest"

import { digest } from "./artifacts.ts"
import {
  EVAL_VERSION,
  attemptSchema,
  normalizeQuestionScope,
  questionSchema,
} from "./contracts.ts"
import { evaluateAttempt } from "./evaluate.ts"
import {
  importJudgeSubmission,
  judgeSubmissionSchema,
  prepareJudgingPacket,
  type PreparedJudgingPacket,
} from "./judging.ts"

// Synthetic controls only. Their recorded check_claims result remains the
// numerical authority; these tests never judge a real answer or call a model.
const question = questionSchema.parse({
  id: "independent-control",
  kind: "role_answer",
  role: "engineer",
  effective_role: "engineer",
  covers: [],
  question: "What should the component owner check next?",
  scope: { dataset: "bgl" },
  required_evidence: ["A scoped count."],
  distinguishing_check: "Inspect component context before recommending.",
  allowed_tool_sequences: [["count_events", "check_claims"]],
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

function control(
  variant: "baseline" | "playbook" = "playbook",
  mutation: "none" | "value" | "metric" | "group" = "none"
) {
  const text = [
    "## Scope\nBGL within the saved scope.",
    "## Answer\n12 events [r_11111111.f1].",
    "## Evidence\nThe saved scoped count.",
    "## Timeline\nTiming remains unknown.",
    "## Narrowing\nOnly the searched component is covered.",
    "## Hypotheses\nThe origin remains open; inspect component context.",
    "## Next check\nAsk the component owner to inspect context.",
    "## Unknown\nCause and business impact remain unknown.",
    "## Verification\nThe submitted claim was checked.",
  ].join("\n")
  const base = {
    created_at: "2026-10-18T10:00:01Z",
    client: "eval",
    tool_version: "control",
    input: {},
    signature: "0".repeat(64),
    data_version: "synthetic-only",
    sql: [],
    params: [],
    scope,
    population: null,
    rows_returned: 1,
    truncated: true,
    row_limit: 1,
    duration_ms: 1,
  }
  const result = { events: 12 }
  const check = {
    claims: [
      {
        claim: {
          fact: "r_11111111.f1",
          value: mutation === "value" ? 13 : 12,
          metric: mutation === "metric" ? "requests" : "events",
          group: mutation === "group" ? { team: "Other team" } : {},
        },
        status: mutation === "none" ? "verified" : "mismatch",
        mismatch_on: mutation === "none" ? [] : [mutation],
        reason:
          mutation === "none"
            ? null
            : "Hand-authored mutated calibration result.",
        fact: { value: 12, metric: "events", unit: "log_events", group: {} },
        receipt: {
          receipt_id: "r_11111111",
          tool: "count_events",
          data_version: "synthetic-only",
          scope,
        },
      },
    ],
    summary: {
      checked: 1,
      verified: mutation === "none" ? 1 : 0,
      mismatch: mutation === "none" ? 0 : 1,
      unresolved: 0,
      text: "Synthetic check.",
    },
  }
  const receipts = [
    receiptSchema.parse({
      ...base,
      receipt_id: "r_11111111",
      tool: "count_events",
      result,
      result_digest: digest(result),
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
      scope: { windows: [], filters: {} },
      result: check,
      result_digest: digest(check),
      facts: [],
    }),
  ]
  const record = runRecordSchema.parse({
    run_id: "run_12345678",
    started_at: "2026-10-18T10:00:00Z",
    finished_at: "2026-10-18T10:00:03Z",
    duration_ms: 3000,
    status: "completed",
    variant,
    role: { requested: "engineer", effective: "engineer" },
    question: question.question,
    scope: question.scope,
    model_id: "offline-control",
    effort: "high",
    guidance_version: "private-guidance-version",
    contract_version: "control",
    data_version: "synthetic-only",
    instruction_texts: ["PRIVATE SOURCE PROMPT"],
    instruction_messages: ["PRIVATE PHASE PROMPT"],
    phases: [
      {
        kind: "investigate",
        steps: receipts.map((receipt, index) => ({
          sequence: index + 1,
          started_at: `2026-10-18T10:00:0${index}Z`,
          finished_at: `2026-10-18T10:00:0${index + 1}Z`,
          tool: receipt.tool,
          input: {},
          receipt_id: receipt.receipt_id,
          duration_ms: 1000,
          error_kind: null,
        })),
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
    coverage_requests: ["PRIVATE AUTHOR RATIONALE"],
    gate_findings: [],
    usage: { input: null, output: null, cache_read: null, cache_write: null },
    final_text: text,
    check_claims: [{ receipt_id: "r_22222222", summary: check.summary }],
    error_kind: null,
  })
  const attempt = attemptSchema.parse({
    schema_version: EVAL_VERSION,
    plan: {
      id: `control-${variant}-1`,
      question_id: question.id,
      variant,
      repetition: 1,
      order: 0,
      required: true,
    },
    started_at: record.started_at,
    finished_at: record.finished_at,
    elapsed_ms: 3000,
    status: "completed",
    error_kind: null,
    record: { file: `runs/${record.run_id}.json`, sha256: digest(record) },
    receipts: receipts.map((receipt) => ({
      file: `receipts/${receipt.receipt_id}.json`,
      sha256: digest(receipt),
    })),
    missing_receipts: [],
  })
  return { attempt, record, receipts }
}

function submission(prepared: PreparedJudgingPacket) {
  const passed = {
    status: "pass",
    reason: "Synthetic independent control assessment.",
  }
  const irrelevant = {
    status: "not_applicable",
    reason: "No such claim in this control.",
  }
  const score = {
    score: 2,
    reason: "Synthetic content rating; no style or ordering bonus.",
  }
  return {
    blind_id: prepared.packet.blind_id,
    packet_sha256: prepared.packet.packet_sha256,
    assessed_at: "2026-10-18T11:00:00Z",
    reviewer: {
      id: "independent-control-reviewer",
      kind: "agent",
      version: "control-v1",
      independent_of_playbooks: true,
    },
    dimensions: {
      scope: passed,
      top_n_generalization: irrelevant,
      out_of_span_zero: irrelevant,
      denominator: irrelevant,
      precursor_causality: passed,
      claim_alignment: passed,
    },
    required_evidence: [
      {
        requirement: question.required_evidence[0],
        ...passed,
        receipt_ids: ["r_11111111"],
      },
    ],
    recommendation_check: {
      ...passed,
      check_sequence: 1,
      recommendation_after_sequence: 2,
    },
    rubric: {
      scope: score,
      evidence: score,
      action: score,
      decision_check: score,
      causal_separation: score,
    },
  }
}

describe("independent blinded judging", () => {
  it("exports deterministic full evidence and keeps the private mapping separate", () => {
    const loaded = control()
    const prepared = prepareJudgingPacket(question, loaded, 100_000)
    expect(
      prepareJudgingPacket(question, loaded, { maxBytes: 100_000 })
    ).toEqual(prepared)
    expect(prepared.packet.final_answer).toBe(loaded.record.final_text)
    expect(prepared.packet.receipts[0]?.receipt).toMatchObject({
      scope,
      truncated: true,
      row_limit: 1,
      result: { events: 12 },
      facts: loaded.receipts[0]?.facts,
    })
    expect(prepared.assignment).toMatchObject({
      attempt_id: loaded.attempt.plan.id,
      question_id: question.id,
      run_id: loaded.record.run_id,
      record_sha256: loaded.attempt.record?.sha256,
    })
    const exported = canonicalJson(prepared.packet)
    for (const secret of [
      "PRIVATE",
      "private-guidance-version",
      "control-playbook-1",
      '"variant":',
      "run_12345678",
      "allowed_tool_sequences",
    ])
      expect(exported).not.toContain(secret)
    expect(exported).toContain("No quality bonus")
  })

  it("uses the same content rubric for both variants while binding IDs to their saved records", () => {
    const first = prepareJudgingPacket(question, control("baseline"), 100_000)
    const second = prepareJudgingPacket(question, control("playbook"), 100_000)
    expect(first.packet.instructions).toEqual(second.packet.instructions)
    expect(first.packet.question).toEqual(second.packet.question)
    expect(first.packet.blind_id).not.toBe(second.packet.blind_id)
    const changed = control()
    changed.record.final_text += "\nA changed answer."
    changed.attempt.record = {
      file: `runs/${changed.record.run_id}.json`,
      sha256: digest(changed.record),
    }
    expect(
      prepareJudgingPacket(question, changed, 100_000).packet.blind_id
    ).not.toBe(second.packet.blind_id)
  })

  it("matches normalized run scopes and legacy aliases without accepting a different filter", () => {
    const scopedQuestion = questionSchema.parse({
      ...question,
      scope: { dataset: "bgl", component: "component-x" },
    })
    const loaded = control()
    loaded.record.scope = normalizeQuestionScope(scopedQuestion)
    loaded.attempt.record = {
      file: `runs/${loaded.record.run_id}.json`,
      sha256: digest(loaded.record),
    }
    expect(
      prepareJudgingPacket(scopedQuestion, loaded, 100_000).packet.question
        .scope
    ).toEqual(scopedQuestion.scope)
    loaded.record.scope = {
      dataset: "bgl",
      filters: { components: ["different-component"] },
    }
    loaded.attempt.record = {
      file: `runs/${loaded.record.run_id}.json`,
      sha256: digest(loaded.record),
    }
    expect(() => prepareJudgingPacket(scopedQuestion, loaded, 100_000)).toThrow(
      /do not match/
    )
  })

  it("fails the explicit UTF-8 context bound without changing the answer or receipts", () => {
    const loaded = control()
    const before = canonicalJson(loaded)
    const full = prepareJudgingPacket(question, loaded, 100_000)
    const bytes = Buffer.byteLength(
      `${JSON.stringify(full.packet, null, 2)}\n`,
      "utf8"
    )
    expect(prepareJudgingPacket(question, loaded, bytes)).toEqual(full)
    expect(() => prepareJudgingPacket(question, loaded, bytes - 1)).toThrow(
      /context.*limit/i
    )
    expect(() => prepareJudgingPacket(question, loaded, 0)).toThrow(/Too small/)
    expect(canonicalJson(loaded)).toBe(before)
  })

  it("rejects missing receipts, mismatched artifacts and absent final answers", () => {
    const missing = control()
    missing.receipts.pop()
    expect(() => prepareJudgingPacket(question, missing, 100_000)).toThrow(
      /receipt/i
    )
    const changed = control()
    changed.record.final_text += " changed"
    expect(() => prepareJudgingPacket(question, changed, 100_000)).toThrow(
      /hash/i
    )
    const noAnswer = control()
    noAnswer.record.final_text = null
    noAnswer.attempt.record = {
      file: `runs/${noAnswer.record.run_id}.json`,
      sha256: digest(noAnswer.record),
    }
    expect(() => prepareJudgingPacket(question, noAnswer, 100_000)).toThrow(
      /final answer/i
    )
    const recordedMissing = control()
    recordedMissing.attempt.missing_receipts.push("r_33333333")
    expect(() =>
      prepareJudgingPacket(question, recordedMissing, 100_000)
    ).toThrow(/receipt/i)
  })

  it("includes transitive check_claims evidence and refuses an omitted source", () => {
    const loaded = control()
    loaded.record.phases = loaded.record.phases.map((phase) => ({
      ...phase,
      steps: phase.steps.filter((step) => step.tool === "check_claims"),
    }))
    loaded.record.final_text = "A submitted claim was checked."
    loaded.record.answer_versions = []
    loaded.receipts = loaded.receipts.filter(
      (receipt) => receipt.tool === "check_claims"
    )
    loaded.attempt.receipts = loaded.attempt.receipts.filter((reference) =>
      reference.file.includes("r_22222222")
    )
    loaded.attempt.record = {
      file: `runs/${loaded.record.run_id}.json`,
      sha256: digest(loaded.record),
    }
    expect(() => prepareJudgingPacket(question, loaded, 100_000)).toThrow(
      /r_11111111/
    )
  })

  it("withholds only describe_corpus guidance while preserving complete factual stats and original receipts", () => {
    const loaded = control()
    const original = loaded.receipts[0]
    if (original === undefined) throw new Error("Missing synthetic receipt")
    const result = {
      events: 12,
      stats: { full: [1, 2, 3] },
      answer_guidance: "PRIVATE GUIDANCE",
      guidance_version: "PRIVATE VERSION",
    }
    loaded.receipts[0] = receiptSchema.parse({
      ...original,
      tool: "describe_corpus",
      result,
      result_digest: digest(result),
    })
    loaded.attempt.receipts = loaded.receipts.map((receipt) => ({
      file: `receipts/${receipt.receipt_id}.json`,
      sha256: digest(receipt),
    }))
    const before = canonicalJson(loaded)
    const projected = prepareJudgingPacket(question, loaded, 100_000).packet
      .receipts[0]
    expect(projected).toMatchObject({
      projection: "describe_corpus_factual",
      original_receipt_sha256: digest(loaded.receipts[0]),
      original_result_digest: digest(result),
      omitted_fields: ["result.answer_guidance", "result.guidance_version"],
      receipt: {
        result: { events: 12, stats: { full: [1, 2, 3] } },
        facts: original.facts,
        scope,
        truncated: true,
      },
    })
    expect(projected?.receipt).not.toHaveProperty("result_digest")
    expect(canonicalJson(projected)).not.toContain("PRIVATE")
    expect(canonicalJson(loaded)).toBe(before)
  })

  it("rejects unrecognized prompt-bearing evidence rather than silently omitting it", () => {
    const loaded = control()
    const original = loaded.receipts[0]
    if (original === undefined) throw new Error("Missing synthetic receipt")
    const result = { events: 12, instructions: "PRIVATE" }
    loaded.receipts[0] = receiptSchema.parse({
      ...original,
      result,
      result_digest: digest(result),
    })
    loaded.attempt.receipts = loaded.receipts.map((receipt) => ({
      file: `receipts/${receipt.receipt_id}.json`,
      sha256: digest(receipt),
    }))
    expect(() => prepareJudgingPacket(question, loaded, 100_000)).toThrow(
      /prompt-bearing/i
    )
  })

  it("imports an explicitly independent packet-bound assessment into the canonical evaluator shape", () => {
    const loaded = control()
    const prepared = prepareJudgingPacket(question, loaded, 100_000)
    const assessment = importJudgeSubmission(submission(prepared), prepared)
    expect(assessment).toMatchObject({
      question_id: question.id,
      run_id: loaded.record.run_id,
      rubric: { scope: { score: 2 } },
    })
    expect(
      evaluateAttempt({
        question,
        record: loaded.record,
        receipts: loaded.receipts,
        semanticAssessment: assessment,
      }).numerical.status
    ).toBe("pass")
  })

  it.each(["value", "metric", "group"] as const)(
    "keeps a saved %s mismatch authoritative despite positive reviewer scores",
    (mutation) => {
      const loaded = control("baseline", mutation)
      const prepared = prepareJudgingPacket(question, loaded, 100_000)
      const assessment = importJudgeSubmission(submission(prepared), prepared)
      const result = evaluateAttempt({
        question,
        record: loaded.record,
        receipts: loaded.receipts,
        semanticAssessment: assessment,
      })
      expect(result.numerical).toMatchObject({ status: "fail", mismatch: 1 })
      expect(result.product_status).toBe("fail")
    }
  )

  it("retains an independently identified unsupported causal status as a failure", () => {
    const loaded = control()
    loaded.record.final_text =
      loaded.record.final_text?.replace(
        "The origin remains open",
        "The distributed origin is proven"
      ) ?? null
    loaded.attempt.record = {
      file: `runs/${loaded.record.run_id}.json`,
      sha256: digest(loaded.record),
    }
    const prepared = prepareJudgingPacket(question, loaded, 100_000)
    const rated = submission(prepared)
    rated.dimensions.precursor_causality = {
      status: "fail",
      reason: "The scoped count cannot prove a distributed origin.",
    }
    rated.rubric.causal_separation = {
      score: 0,
      reason: "A causal status is asserted without discriminating evidence.",
    }
    const assessment = importJudgeSubmission(rated, prepared)
    const result = evaluateAttempt({
      question,
      record: loaded.record,
      receipts: loaded.receipts,
      semanticAssessment: assessment,
    })
    expect(result.numerical.status).toBe("pass")
    expect(result.semantic.precursor_causality.status).toBe("fail")
    expect(result.rubric?.causal_separation.score).toBe(0)
    expect(result.product_status).toBe("fail")
  })

  it("leaves claimed check-before-recommendation success unknown without the saved chronology", () => {
    const loaded = control()
    delete loaded.record.answer_versions
    loaded.attempt.record = {
      file: `runs/${loaded.record.run_id}.json`,
      sha256: digest(loaded.record),
    }
    const prepared = prepareJudgingPacket(question, loaded, 100_000)
    expect(prepared.packet.chronology.answer_versions).toBeNull()
    const assessment = importJudgeSubmission(submission(prepared), prepared)
    expect(
      evaluateAttempt({
        question,
        record: loaded.record,
        receipts: loaded.receipts,
        semanticAssessment: assessment,
      }).recommendation_check.status
    ).toBe("unknown")
  })

  it("rejects false independence, missing dimensions/reasons, packet mismatch and stale mappings", () => {
    const prepared = prepareJudgingPacket(question, control(), 100_000)
    const rated = submission(prepared)
    expect(
      judgeSubmissionSchema.safeParse({
        ...rated,
        reviewer: { ...rated.reviewer, independent_of_playbooks: false },
      }).success
    ).toBe(false)
    expect(
      judgeSubmissionSchema.safeParse({
        ...rated,
        rubric: { ...rated.rubric, scope: { score: 3, reason: "" } },
      }).success
    ).toBe(false)
    expect(() =>
      importJudgeSubmission(
        { ...rated, packet_sha256: "0".repeat(64) },
        prepared
      )
    ).toThrow(/packet/i)
    const tampered = structuredClone(prepared)
    tampered.packet.final_answer += " silently changed"
    expect(() => importJudgeSubmission(rated, tampered)).toThrow(/hash/i)
    const rebound = structuredClone(prepared)
    rebound.assignment.run_id = "run_87654321"
    expect(() => importJudgeSubmission(rated, rebound)).toThrow(/bind/i)
    expect(() =>
      importJudgeSubmission({ ...rated, required_evidence: [] }, prepared)
    ).toThrow(/required evidence/i)
    expect(() =>
      importJudgeSubmission(
        {
          ...rated,
          required_evidence: [
            { ...rated.required_evidence[0], receipt_ids: ["r_99999999"] },
          ],
        },
        prepared
      )
    ).toThrow(/receipt/i)
  })
})
