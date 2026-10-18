import { describe, expect, it } from "vitest"
import { digest } from "./artifacts.ts"
import {
  auditHumanSample,
  buildHumanSamplePolicy,
  buildPairPlan,
  evaluateCommonCase,
  summarizeComparisons,
  type CommonCaseContent,
  type PairJudgment,
  type PairPlan,
} from "./comparison.ts"

const reviewer = {
  id: "independent-reviewer",
  version: "1",
  kind: "agent" as const,
  independent_of_playbooks: true as const,
}
const assessed_at = "2026-10-18T12:00:00.000Z"
function plan(role: "engineer" | "team_lead" | "manager" = "engineer") {
  return buildPairPlan({
    id: `pair-${role}`,
    question_id: `question-${role}`,
    role,
    repetition: 1,
    answers: [
      {
        answer_id: `${role}-a`,
        packet_sha256: digest(`${role}-a`),
        variant: "baseline",
      },
      {
        answer_id: `${role}-b`,
        packet_sha256: digest(`${role}-b`),
        variant: "playbook",
      },
    ],
  })
}
function judgment(
  p: PairPlan,
  order: 0 | 1,
  winner: PairJudgment["winner"]
): PairJudgment {
  return {
    pair_id: p.id,
    pair_sha256: digest(p),
    order_id: p.orders[order].id,
    answer_ids: p.orders[order].answer_ids,
    winner,
    reason: "Independent content comparison with the complete evidence.",
    reviewer,
    assessed_at,
  }
}

describe("two-order comparison", () => {
  it("counts a winner only when the same opaque answer wins both orders", () => {
    const p = plan()
    const first = judgment(p, 0, "first")
    const second = judgment(p, 1, "second")
    const report = summarizeComparisons([p], [first, second])
    expect(report.pairs[0]).toMatchObject({
      status: "consistent_win",
      winner_answer_id: p.orders[0].answer_ids[0],
    })
    expect(report.totals).toMatchObject({
      planned_pairs: 1,
      valid_two_order_pairs: 1,
      consistent_decision_pairs: 1,
    })
    expect(
      report.groups.find((g) => g.variant === report.pairs[0]?.winner_variant)
    ).toMatchObject({ wins: 1, denominator: 1 })
  })

  it("keeps an order preference, consistent ties and missing comparisons separate", () => {
    const p = plan()
    const conflict = summarizeComparisons(
      [p],
      [judgment(p, 0, "first"), judgment(p, 1, "first")]
    )
    expect(conflict.pairs[0]?.status).toBe("order_disagreement")
    expect(conflict.totals).toMatchObject({
      order_disagreements: 1,
      consistent_decision_pairs: 0,
    })
    const tied = summarizeComparisons(
      [p],
      [judgment(p, 0, "tie"), judgment(p, 1, "tie")]
    )
    expect(tied.totals).toMatchObject({ ties: 1, consistent_decision_pairs: 1 })
    const missing = summarizeComparisons([p], [judgment(p, 0, "first")])
    expect(missing.totals).toMatchObject({
      missing_pairs: 1,
      valid_two_order_pairs: 0,
      consistent_decision_pairs: 0,
    })
    const partialTie = summarizeComparisons(
      [p],
      [judgment(p, 0, "tie"), judgment(p, 1, "second")]
    )
    expect(partialTie.pairs[0]?.status).toBe("order_disagreement")
  })

  it("rejects reused packets and duplicate orders and preserves unknown", () => {
    const p = plan()
    const changed = {
      ...judgment(p, 0, "first"),
      pair_sha256: digest("different round"),
    }
    expect(
      summarizeComparisons([p], [changed, judgment(p, 1, "second")]).pairs[0]
        ?.status
    ).toBe("invalid")
    expect(
      summarizeComparisons(
        [p],
        [judgment(p, 0, "first"), judgment(p, 0, "first")]
      ).pairs[0]?.status
    ).toBe("invalid")
    expect(
      summarizeComparisons(
        [p],
        [judgment(p, 0, "unknown"), judgment(p, 1, "tie")]
      ).pairs[0]?.status
    ).toBe("unknown")
  })
})

describe("predeclared human spot-check", () => {
  it("requires one pair per role, every critical scope/causal finding and conflicts", () => {
    const plans = [plan("engineer"), plan("team_lead"), plan("manager")]
    const policy = buildHumanSamplePolicy(plans, assessed_at)
    const summary = summarizeComparisons(plans, [])
    const finding = {
      id: "critical-scope",
      dimension: "scope" as const,
      critical: true,
      original: { status: "fail", reason: "Scope widened." },
    }
    const audit = auditHumanSample({
      policy,
      plans,
      summary,
      findings: [finding],
      reviews: [],
    })
    expect(audit.status).toBe("unknown")
    expect(audit.required_targets).toHaveLength(4)
    expect(audit.missing_targets).toHaveLength(4)
  })

  it("binds human corrections to the original automated result without replacing it", () => {
    const plans = [plan("engineer"), plan("team_lead"), plan("manager")]
    const policy = buildHumanSamplePolicy(plans, assessed_at)
    const summary = summarizeComparisons(plans, [])
    const empty = auditHumanSample({
      policy,
      plans,
      summary,
      findings: [],
      reviews: [],
    })
    const reviews = empty.required_targets.map((target) => ({
      target_kind: target.kind,
      target_id: target.id,
      original: target.original,
      original_sha256: target.sha256,
      decision: "confirm" as const,
      correction: null,
      reason: "Human verified the complete pair and source evidence.",
      assessed_at,
      reviewer: { ...reviewer, kind: "human" as const },
    }))
    expect(
      auditHumanSample({ policy, plans, summary, findings: [], reviews }).status
    ).toBe("pass")
    const first = reviews[0]
    if (first === undefined) throw new Error("Missing human control")
    const correction = {
      ...first,
      decision: "correct" as const,
      correction: {
        verdict: "fail",
        reason:
          "The original positive overlooked an unsupported causal statement.",
      },
    }
    const corrected = auditHumanSample({
      policy,
      plans,
      summary,
      findings: [],
      reviews: [correction, ...reviews.slice(1)],
    })
    expect(corrected.status).toBe("unknown")
    expect(corrected.reviews[0]?.correction).toEqual(correction.correction)
    first.original_sha256 = digest("another result")
    const stale = auditHumanSample({
      policy,
      plans,
      summary,
      findings: [],
      reviews,
    })
    expect(stale.status).toBe("unknown")
    expect(stale.invalid_reviews).toHaveLength(1)
  })
})

describe("S-13 common structured case", () => {
  const members = ["engineer", "team_lead", "manager"].map((role) => ({
    role,
    answer_id: `answer-${role}`,
    packet_sha256: digest(role),
    data_version: "dataset-v1",
    scope: {
      dataset: "openstack",
      start: "2017-05-14T00:00:00Z",
      end: "2017-05-15T00:00:00Z",
    },
    tool_results: [
      {
        tool: "count_events",
        input: { dataset: "openstack" },
        result_sha256: digest("the same stored result"),
      },
    ],
  }))
  it("leaves content quality unknown despite equal scope and source results", () => {
    expect(evaluateCommonCase({ id: "s13", members }).status).toBe("unknown")
  })
  it("fails mismatched data/scope and identical-input conflicting results", () => {
    const changed = structuredClone(members)
    const last = changed.at(-1)
    if (last === undefined) throw new Error("Missing S13 control")
    last.data_version = "different"
    expect(evaluateCommonCase({ id: "s13", members: changed }).status).toBe(
      "fail"
    )
    last.data_version = "dataset-v1"
    last.tool_results = [
      {
        tool: "count_events",
        input: { dataset: "openstack" },
        result_sha256: digest("conflicting result"),
      },
    ]
    expect(
      evaluateCommonCase({ id: "s13", members: changed }).numeric_consistency
        .status
    ).toBe("fail")
  })
  it("requires an independent hash-bound role-specific content judgment", () => {
    const input = { id: "s13", members }
    const content: CommonCaseContent = {
      case_id: "s13",
      case_sha256: digest(input),
      reviewer,
      assessed_at,
      roles: {
        engineer: {
          status: "pass",
          reason: "Concrete hypothesis and discriminating follow-up.",
        },
        team_lead: {
          status: "pass",
          reason: "Team and object allocation with breadth and next-day work.",
        },
        manager: {
          status: "pass",
          reason: "Episode/breadth priority, trade-off and decision criterion.",
        },
      },
    }
    expect(evaluateCommonCase({ ...input, content }).status).toBe("pass")
    expect(
      evaluateCommonCase({
        ...input,
        content: { ...content, case_sha256: digest("old case") },
      }).status
    ).toBe("unknown")
  })
})
