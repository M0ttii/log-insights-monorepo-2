import { answerRoleSchema } from "@workspace/domain/answer"
import { canonicalJson } from "@workspace/domain/receipt"
import { z } from "zod"
import { digest } from "./artifacts.ts"
import { semanticAssessmentSchema } from "./evaluate.ts"

const id = z.string().min(1).max(200)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const variant = z.enum(["baseline", "playbook"])
const reviewerSchema = semanticAssessmentSchema.shape.reviewer.extend({
  id,
  version: id,
})
const answerSchema = z.strictObject({
  answer_id: id,
  packet_sha256: hash,
  variant,
})
const orderSchema = z.strictObject({ id, answer_ids: z.tuple([id, id]) })
export const pairPlanSchema = z
  .strictObject({
    id,
    question_id: id,
    role: answerRoleSchema,
    repetition: z.number().int().positive(),
    answers: z.tuple([answerSchema, answerSchema]),
    orders: z.tuple([orderSchema, orderSchema]),
  })
  .superRefine((plan, context) => {
    const [a, b] = plan.answers
    const [forward, reverse] = plan.orders
    if (
      a.answer_id === b.answer_id ||
      a.variant === b.variant ||
      forward.id === reverse.id ||
      new Set(forward.answer_ids).size !== 2 ||
      !forward.answer_ids.every((answerId) =>
        [a.answer_id, b.answer_id].includes(answerId)
      ) ||
      canonicalJson(forward.answer_ids.toReversed()) !==
        canonicalJson(reverse.answer_ids)
    )
      context.addIssue({
        code: "custom",
        message: "A pair needs two distinct variants and both answer orders",
      })
  })
export type PairPlan = z.infer<typeof pairPlanSchema>

/** Private variant mapping; only orders and opaque answer packets go to a judge. */
export function buildPairPlan(input: Omit<PairPlan, "orders">): PairPlan {
  const answerIds: [string, string] = [
    input.answers[0].answer_id,
    input.answers[1].answer_id,
  ]
  if (answerIds.some((answerId) => /baseline|playbook/i.test(answerId)))
    throw new Error("Comparison answer IDs must not reveal variants")
  if (Number.parseInt(digest(input.id).slice(0, 2), 16) % 2 === 1)
    answerIds.reverse()
  return pairPlanSchema.parse({
    ...input,
    orders: [
      { id: `${input.id}-1`, answer_ids: answerIds },
      { id: `${input.id}-2`, answer_ids: answerIds.toReversed() },
    ],
  })
}

export const pairJudgmentSchema = z.strictObject({
  pair_id: id,
  pair_sha256: hash,
  order_id: id,
  answer_ids: z.tuple([id, id]),
  winner: z.enum(["first", "second", "tie", "unknown"]),
  reason: z.string().min(1),
  reviewer: reviewerSchema,
  assessed_at: z.iso.datetime(),
})
export type PairJudgment = z.infer<typeof pairJudgmentSchema>

function summarizePair(plan: PairPlan, judgments: PairJudgment[]) {
  const invalid =
    judgments.some((judgment) => {
      const order = plan.orders.find((item) => item.id === judgment.order_id)
      return (
        judgment.pair_sha256 !== digest(plan) ||
        order === undefined ||
        canonicalJson(judgment.answer_ids) !== canonicalJson(order.answer_ids)
      )
    }) ||
    new Set(judgments.map((judgment) => judgment.order_id)).size !==
      judgments.length
  const status = invalid
    ? "invalid"
    : judgments.length !== 2
      ? "missing"
      : judgments.some((judgment) => judgment.winner === "unknown")
        ? "unknown"
        : null
  const winners = judgments.map((judgment) =>
    judgment.winner === "first"
      ? judgment.answer_ids[0]
      : judgment.winner === "second"
        ? judgment.answer_ids[1]
        : null
  )
  const consistent = status === null && winners[0] === winners[1]
  const winner = consistent ? (winners[0] ?? null) : null
  return {
    pair_id: plan.id,
    pair_sha256: digest(plan),
    question_id: plan.question_id,
    role: plan.role,
    repetition: plan.repetition,
    status:
      status ??
      (consistent
        ? winner === null
          ? "tie"
          : "consistent_win"
        : "order_disagreement"),
    winner_answer_id: winner,
    winner_variant:
      plan.answers.find((answer) => answer.answer_id === winner)?.variant ??
      null,
    judgments,
  }
}

/** Metadata counts retain missing, unknown and order-sensitive results separately. */
export function summarizeComparisons(
  plansInput: PairPlan[],
  judgmentsInput: PairJudgment[]
) {
  const plans = plansInput.map((plan) => pairPlanSchema.parse(plan))
  const judgments = judgmentsInput.map((judgment) =>
    pairJudgmentSchema.parse(judgment)
  )
  if (new Set(plans.map((plan) => plan.id)).size !== plans.length)
    throw new Error("Duplicate comparison plans")
  if (
    judgments.some(
      (judgment) => !plans.some((plan) => plan.id === judgment.pair_id)
    )
  )
    throw new Error("Judgment belongs to an unplanned pair")
  const pairs = plans.map((plan) =>
    summarizePair(
      plan,
      judgments.filter((judgment) => judgment.pair_id === plan.id)
    )
  )
  const count = (status: string) =>
    pairs.filter((pair) => pair.status === status).length
  const groups = plans
    .flatMap((plan) =>
      variant.options.map((which) => ({
        role: plan.role,
        question_id: plan.question_id,
        variant: which,
      }))
    )
    .filter(
      (group, index, all) =>
        all.findIndex(
          (other) => canonicalJson(other) === canonicalJson(group)
        ) === index
    )
    .map((group) => {
      const matching = pairs.filter(
        (pair) =>
          pair.role === group.role && pair.question_id === group.question_id
      )
      const n = (status: string) =>
        matching.filter((pair) => pair.status === status).length
      return {
        ...group,
        planned_pairs: matching.length,
        valid_two_order_pairs: matching.filter(
          (pair) => !["missing", "invalid"].includes(pair.status)
        ).length,
        denominator: n("consistent_win") + n("tie"),
        wins: matching.filter(
          (pair) =>
            pair.status === "consistent_win" &&
            pair.winner_variant === group.variant
        ).length,
        losses: matching.filter(
          (pair) =>
            pair.status === "consistent_win" &&
            pair.winner_variant !== group.variant
        ).length,
        ties: n("tie"),
        order_disagreements: n("order_disagreement"),
        missing_pairs: n("missing"),
        invalid_pairs: n("invalid"),
        unknown_pairs: n("unknown"),
      }
    })
  return {
    pairs,
    groups,
    totals: {
      planned_pairs: plans.length,
      valid_two_order_pairs: pairs.filter(
        (pair) => !["missing", "invalid"].includes(pair.status)
      ).length,
      consistent_decision_pairs: count("consistent_win") + count("tie"),
      ties: count("tie"),
      order_disagreements: count("order_disagreement"),
      missing_pairs: count("missing"),
      invalid_pairs: count("invalid"),
      unknown_pairs: count("unknown"),
    },
  }
}
export type ComparisonSummary = ReturnType<typeof summarizeComparisons>

export const humanSamplePolicySchema = z.strictObject({
  declared_at: z.iso.datetime(),
  plans_sha256: hash,
  minimum_pairs_per_role: z.literal(1),
  selected_pair_ids: z.array(id).min(3),
  all_critical_scope_and_causality: z.literal(true),
  all_order_disagreements: z.literal(true),
})
export type HumanSamplePolicy = z.infer<typeof humanSamplePolicySchema>
export function buildHumanSamplePolicy(
  plans: PairPlan[],
  declaredAt: string,
  selectedPairIds?: string[]
): HumanSamplePolicy {
  const selected =
    selectedPairIds ??
    answerRoleSchema.options.map((role) => {
      const plan = plans.find((candidate) => candidate.role === role)
      if (plan === undefined)
        throw new Error(`Missing human sample for ${role}`)
      return plan.id
    })
  if (
    new Set(selected).size !== selected.length ||
    selected.some((pairId) => !plans.some((plan) => plan.id === pairId)) ||
    answerRoleSchema.options.some(
      (role) =>
        !plans.some((plan) => plan.role === role && selected.includes(plan.id))
    )
  )
    throw new Error(
      "Human sample must select at least one declared pair per role"
    )
  return humanSamplePolicySchema.parse({
    declared_at: declaredAt,
    plans_sha256: digest(plans),
    minimum_pairs_per_role: 1,
    selected_pair_ids: selected,
    all_critical_scope_and_causality: true,
    all_order_disagreements: true,
  })
}

export const humanReviewSchema = z
  .strictObject({
    target_kind: z.enum(["pair", "finding"]),
    target_id: id,
    original: z.json(),
    original_sha256: hash,
    decision: z.enum(["confirm", "correct", "unresolved"]),
    correction: z.json().nullable(),
    reason: z.string().min(1),
    reviewer: reviewerSchema.extend({ kind: z.literal("human") }),
    assessed_at: z.iso.datetime(),
  })
  .superRefine((review, context) => {
    if (
      digest(review.original) !== review.original_sha256 ||
      (review.decision === "correct") !== (review.correction !== null)
    )
      context.addIssue({
        code: "custom",
        message:
          "Human review needs an unchanged original and an explicit correction only when corrected",
      })
  })
export type HumanReview = z.infer<typeof humanReviewSchema>
const findingSchema = z.strictObject({
  id,
  dimension: z.enum(["scope", "causality"]),
  critical: z.boolean(),
  original: z.json(),
})
export type CriticalFinding = z.infer<typeof findingSchema>

/** A correction is retained alongside its source; it never overwrites a judge. */
export function auditHumanSample(input: {
  policy: HumanSamplePolicy
  plans: PairPlan[]
  summary: ComparisonSummary
  findings: CriticalFinding[]
  reviews: HumanReview[]
}) {
  const policy = humanSamplePolicySchema.parse(input.policy)
  if (policy.plans_sha256 !== digest(input.plans))
    throw new Error("Human sample policy belongs to a different plan")
  const verifiedPolicy = buildHumanSamplePolicy(
    input.plans,
    policy.declared_at,
    policy.selected_pair_ids
  )
  if (digest(verifiedPolicy) !== digest(policy))
    throw new Error("Invalid human sample policy")
  const verifiedSummary = summarizeComparisons(
    input.plans,
    input.summary.pairs.flatMap((pair) => pair.judgments)
  )
  if (digest(verifiedSummary) !== digest(input.summary))
    throw new Error("Comparison summary differs from its bound judgments")
  const required = new Set([
    ...policy.selected_pair_ids,
    ...input.summary.pairs
      .filter((pair) => pair.status === "order_disagreement")
      .map((pair) => pair.pair_id),
  ])
  const targets = [
    ...input.summary.pairs
      .filter((pair) => required.has(pair.pair_id))
      .map((pair) => ({
        kind: "pair" as const,
        id: pair.pair_id,
        sha256: digest(pair),
        original: z.json().parse(pair),
      })),
    ...input.findings
      .map((finding) => findingSchema.parse(finding))
      .filter((finding) => finding.critical)
      .map((finding) => ({
        kind: "finding" as const,
        id: finding.id,
        sha256: digest(finding.original),
        original: finding.original,
      })),
  ]
  const invalidReviews: { target_id: string; reason: string }[] = []
  const completed = new Set<string>()
  const seen = new Set<string>()
  for (const value of input.reviews) {
    const parsed = humanReviewSchema.safeParse(value)
    const target = targets.find(
      (candidate) =>
        candidate.kind === value.target_kind && candidate.id === value.target_id
    )
    const key = `${value.target_kind}:${value.target_id}`
    if (
      !parsed.success ||
      target === undefined ||
      target.sha256 !== value.original_sha256 ||
      seen.has(key)
    ) {
      invalidReviews.push({
        target_id: value.target_id,
        reason: "Invalid, duplicate or stale human review binding",
      })
      completed.delete(key)
    } else if (value.decision === "confirm") completed.add(key)
    seen.add(key)
  }
  const missing = targets.filter(
    (target) => !completed.has(`${target.kind}:${target.id}`)
  )
  return {
    status:
      missing.length === 0 && invalidReviews.length === 0
        ? ("pass" as const)
        : ("unknown" as const),
    required_targets: targets,
    missing_targets: missing,
    invalid_reviews: invalidReviews,
    reviews: input.reviews,
  }
}

const memberSchema = z.strictObject({
  role: answerRoleSchema,
  answer_id: id,
  packet_sha256: hash,
  data_version: id,
  scope: z.record(z.string(), z.json()),
  tool_results: z.array(
    z.strictObject({ tool: id, input: z.json(), result_sha256: hash })
  ),
})
const contentRatingSchema = z.strictObject({
  status: z.enum(["pass", "fail", "unknown"]),
  reason: z.string().min(1),
})
export const commonCaseContentSchema = z.strictObject({
  case_id: id,
  case_sha256: hash,
  reviewer: reviewerSchema,
  assessed_at: z.iso.datetime(),
  roles: z.strictObject({
    engineer: contentRatingSchema,
    team_lead: contentRatingSchema,
    manager: contentRatingSchema,
  }),
})
export type CommonCaseContent = z.infer<typeof commonCaseContentSchema>
export type CommonCaseMember = z.infer<typeof memberSchema>

/** Scope/data equality alone cannot establish the required role-specific content. */
export function evaluateCommonCase(input: {
  id: string
  members: unknown[]
  content?: CommonCaseContent
}) {
  const members = input.members.map((member) => memberSchema.parse(member))
  const complete =
    members.length === 3 &&
    new Set(members.map((member) => member.role)).size === 3
  const sameScope =
    complete &&
    new Set(members.map((member) => digest(member.scope))).size === 1
  const sameData =
    complete && new Set(members.map((member) => member.data_version)).size === 1
  const results = new Map<
    string,
    { roles: Set<string>; digests: Set<string> }
  >()
  for (const member of members)
    for (const result of member.tool_results) {
      const key = digest({
        tool: result.tool,
        input: result.input,
        data_version: member.data_version,
      })
      const group = results.get(key) ?? {
        roles: new Set<string>(),
        digests: new Set<string>(),
      }
      group.roles.add(member.role)
      group.digests.add(result.result_sha256)
      results.set(key, group)
    }
  const shared = [...results.values()].filter((group) => group.roles.size > 1)
  const conflicts = shared.filter((group) => group.digests.size !== 1).length
  const numeric = {
    status:
      conflicts > 0
        ? ("fail" as const)
        : shared.length > 0
          ? ("pass" as const)
          : ("not_comparable" as const),
    shared_input_groups: shared.length,
    conflicting_groups: conflicts,
  }
  const content =
    input.content === undefined
      ? null
      : commonCaseContentSchema.parse(input.content)
  const bound =
    content !== null &&
    content.case_id === input.id &&
    content.case_sha256 === digest({ id: input.id, members })
  const ratings = bound
    ? Object.values(content.roles).map((rating) => rating.status)
    : []
  const failed =
    complete &&
    (!sameScope || !sameData || conflicts > 0 || ratings.includes("fail"))
  const passed =
    complete &&
    sameScope &&
    sameData &&
    bound &&
    ratings.every((rating) => rating === "pass")
  return {
    case_id: input.id,
    case_sha256: digest({ id: input.id, members }),
    status: failed
      ? ("fail" as const)
      : passed
        ? ("pass" as const)
        : ("unknown" as const),
    complete,
    same_scope: sameScope,
    same_data_version: sameData,
    numeric_consistency: numeric,
    content_binding_valid: bound,
    content,
  }
}
