import { readFile } from "node:fs/promises"
import { z } from "zod"
import {
  digest,
  loadAttempt,
  readArtifact,
  writeArtifact,
} from "./artifacts.ts"
import {
  auditHumanSample,
  buildHumanSamplePolicy,
  buildPairPlan,
  commonCaseContentSchema,
  evaluateCommonCase,
  humanReviewSchema,
  humanSamplePolicySchema,
  pairJudgmentSchema,
  pairPlanSchema,
  summarizeComparisons,
  type CommonCaseMember,
  type PairPlan,
} from "./comparison.ts"
import {
  importJudgeSubmission,
  judgeSubmissionSchema,
  judgingAssignmentSchema,
  judgingPacketSchema,
  prepareJudgingPacket,
  type PreparedJudgingPacket,
} from "./judging.ts"
import { loadRoundSnapshot, recomputeReport } from "./report.ts"
import {
  auditCalibration,
  calibrationPacket,
  calibrationSchema,
} from "./calibration.ts"

const safeVersion = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const unavailableSchema = z.strictObject({
  attempt_id: z.string(),
  error_kind: z.string(),
})
const memberSchema = z.strictObject({
  role: z.enum(["engineer", "team_lead", "manager"]),
  answer_id: z.string(),
  packet_sha256: hash,
  data_version: z.string(),
  scope: z.record(z.string(), z.json()),
  tool_results: z.array(
    z.strictObject({ tool: z.string(), input: z.json(), result_sha256: hash })
  ),
})
const referenceSchema = z.strictObject({
  file: z
    .string()
    .regex(
      /^(packets|pairs|common-cases)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}\.json$/
    ),
  sha256: hash,
})
const preparationSchema = z.strictObject({
  version: safeVersion,
  manifest_sha256: hash,
  questions_sha256: hash,
  calibration: z.strictObject({
    file: z
      .string()
      .regex(/^calibration\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.json$/),
    sha256: hash,
    source_sha256: hash,
  }),
  assignments: z.array(judgingAssignmentSchema),
  packet_references: z.array(referenceSchema),
  pairs: z.array(pairPlanSchema),
  pair_packets: z.array(referenceSchema),
  human_policy: humanSamplePolicySchema,
  common_cases: z.array(
    z.strictObject({
      id: z.string(),
      members: z.array(memberSchema),
      packet: referenceSchema.nullable(),
    })
  ),
  unavailable: z.array(unavailableSchema),
  pair_errors: z.array(
    z.strictObject({ pair_id: z.string(), error_kind: z.string() })
  ),
})
export type ReviewPreparation = z.infer<typeof preparationSchema>
const developmentReviewInputSchema = z.strictObject({
  judge_submissions: z.array(judgeSubmissionSchema),
  pair_judgments: z.array(pairJudgmentSchema),
  human_reviews: z.array(humanReviewSchema),
  s13_content: z.array(commonCaseContentSchema),
  calibrations: z.array(calibrationSchema).optional(),
})
function failureKind(error: unknown): string {
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return "missing_artifact"
  if (error instanceof Error && /context.*limit/i.test(error.message))
    return "review_context_limit"
  return "invalid_review_evidence"
}

/** Prepares complete, immutable blind evidence. Missing/error attempts stay planned. */
export async function prepareReview(
  dir: string,
  versionInput: string
): Promise<ReviewPreparation> {
  const version = safeVersion.parse(versionInput)
  const { manifest, bank: questions } = await loadRoundSnapshot(dir)
  const maxBytes = manifest.experiment?.judge_max_bytes ?? 1_048_576
  const calibration = calibrationPacket(
    await readFile(new URL("./evaluate.test.ts", import.meta.url), "utf8")
  )
  const calibrationFile = `calibration/${version}.json`
  const calibrationReference = {
    file: calibrationFile,
    sha256: await writeArtifact(dir, calibrationFile, calibration),
    source_sha256: calibration.source_sha256,
  }
  const prepared = new Map<string, PreparedJudgingPacket>()
  const loaded = new Map<string, Awaited<ReturnType<typeof loadAttempt>>>()
  const assignments: ReviewPreparation["assignments"] = []
  const packetReferences: ReviewPreparation["packet_references"] = []
  const unavailable: ReviewPreparation["unavailable"] = []
  for (const plan of manifest.attempts) {
    const question = questions.questions.find(
      (candidate) => candidate.id === plan.question_id
    )
    if (question === undefined)
      throw new Error("Unknown planned review question")
    let packet: PreparedJudgingPacket
    try {
      const attempt = await loadAttempt(dir, plan)
      loaded.set(plan.id, attempt)
      packet = prepareJudgingPacket(question, attempt, maxBytes)
    } catch (error) {
      unavailable.push({ attempt_id: plan.id, error_kind: failureKind(error) })
      continue
    }
    prepared.set(plan.id, packet)
    assignments.push(packet.assignment)
    const file = `packets/${version}/${packet.packet.blind_id}.json`
    packetReferences.push({
      file,
      sha256: await writeArtifact(dir, file, packet.packet),
    })
  }
  const manifestHash = digest(manifest)
  const pairs: PairPlan[] = []
  for (const plan of manifest.attempts) {
    if (plan.variant !== "baseline" || plan.experiment === "effort") continue
    const question = questions.questions.find(
      (candidate) => candidate.id === plan.question_id
    )
    if (question?.effective_role === null || question === undefined) continue
    const counterpart = manifest.attempts.find(
      (candidate) =>
        candidate.question_id === plan.question_id &&
        candidate.repetition === plan.repetition &&
        candidate.variant === "playbook" &&
        candidate.experiment !== "effort"
    )
    if (counterpart === undefined)
      throw new Error("Missing planned comparison counterpart")
    const answers = [plan, counterpart].map((attempt) => {
      const packet = prepared.get(attempt.id)?.packet
      return {
        answer_id:
          packet?.blind_id ??
          `unavailable_${digest({ manifestHash, attempt: attempt.id })}`,
        packet_sha256:
          packet?.packet_sha256 ??
          digest({ unavailable: attempt.id, manifestHash }),
        variant: attempt.variant,
      }
    })
    const [first, second] = answers
    if (first === undefined || second === undefined)
      throw new Error("Missing pair bindings")
    pairs.push(
      buildPairPlan({
        id: `pair_${digest({ manifestHash, question: plan.question_id, repetition: plan.repetition })}`,
        question_id: plan.question_id,
        role: question.effective_role,
        repetition: plan.repetition,
        answers: [first, second],
      })
    )
  }
  const pairPackets: ReviewPreparation["pair_packets"] = []
  const pairErrors: ReviewPreparation["pair_errors"] = []
  for (const pair of pairs) {
    const packets = pair.answers.map(
      (answer) =>
        [...prepared.values()].find(
          (value) => value.packet.blind_id === answer.answer_id
        )?.packet
    )
    if (packets.some((packet) => packet === undefined)) {
      pairErrors.push({ pair_id: pair.id, error_kind: "missing_pair_evidence" })
      continue
    }
    for (const order of pair.orders) {
      const packet = {
        pair_id: pair.id,
        pair_sha256: digest(pair),
        order_id: order.id,
        answer_ids: order.answer_ids,
        instructions:
          "Compare content quality for the stated role with all source evidence. No quality bonus for headings, answer length or a fixed tool order. Select first, second, tie or unknown, explain why, and declare independence. Do not infer or name variants. Judge this order independently of the reverse order.",
        answers: order.answer_ids.map((answerId) =>
          packets.find((item) => item?.blind_id === answerId)
        ),
      }
      if (
        Buffer.byteLength(`${JSON.stringify(packet, null, 2)}\n`, "utf8") >
        maxBytes
      ) {
        pairErrors.push({
          pair_id: pair.id,
          error_kind: "review_context_limit",
        })
        break
      }
      const file = `pairs/${version}/${order.id}.json`
      pairPackets.push({ file, sha256: await writeArtifact(dir, file, packet) })
    }
  }
  const humanQuestions =
    manifest.experiment?.human_question_ids ?? manifest.repeated_questions
  const humanPairs = humanQuestions.map((questionId) => {
    const pair = pairs.find(
      (candidate) =>
        candidate.question_id === questionId && candidate.repetition === 1
    )
    if (pair === undefined)
      throw new Error("Predeclared human pair is unavailable in the plan")
    return pair.id
  })
  const commonCases: ReviewPreparation["common_cases"] = []
  const caseIds = [
    ...new Set(
      questions.questions.flatMap((question) =>
        question.common_case === undefined ? [] : [question.common_case]
      )
    ),
  ]
  for (const caseId of caseIds) {
    const members: CommonCaseMember[] = []
    for (const question of questions.questions.filter(
      (candidate) => candidate.common_case === caseId
    )) {
      const plan = manifest.attempts.find(
        (candidate) =>
          candidate.question_id === question.id &&
          candidate.variant === "playbook" &&
          candidate.repetition === 1 &&
          candidate.experiment !== "effort"
      )
      const attempt = plan === undefined ? undefined : loaded.get(plan.id)
      const packet =
        plan === undefined ? undefined : prepared.get(plan.id)?.packet
      if (
        attempt?.record === null ||
        attempt?.record === undefined ||
        attempt.record.data_version === null ||
        packet === undefined ||
        question.effective_role === null
      )
        continue
      members.push({
        role: question.effective_role,
        answer_id: packet.blind_id,
        packet_sha256: packet.packet_sha256,
        data_version: attempt.record.data_version,
        scope: z.record(z.string(), z.json()).parse(attempt.record.scope),
        tool_results: attempt.receipts
          .filter(
            (receipt) =>
              !["describe_corpus", "check_claims"].includes(receipt.tool)
          )
          .map((receipt) => ({
            tool: receipt.tool,
            input: z.json().parse(receipt.input),
            result_sha256: receipt.result_digest,
          })),
      })
    }
    let reference: z.infer<typeof referenceSchema> | null = null
    if (members.length === 3) {
      const packet = {
        case_id: caseId,
        case_sha256: digest({ id: caseId, members }),
        members,
        instructions:
          "Independently assess substantive role differences in the same scoped case. Engineer: evidence, hypothesis and discriminating follow-up. Team lead: recurring breadth, team/object allocation and concrete next-day work. Manager: episode/breadth priority, trade-off, decision and acceptance criterion. Shared wording or headings alone earns no credit. Distinguish unknown evidence from failure.",
        answers: members.map(
          (member) =>
            [...prepared.values()].find(
              (item) => item.packet.blind_id === member.answer_id
            )?.packet
        ),
      }
      if (
        Buffer.byteLength(`${JSON.stringify(packet, null, 2)}\n`, "utf8") <=
        maxBytes
      ) {
        const file = `common-cases/${version}/${caseId}.json`
        reference = { file, sha256: await writeArtifact(dir, file, packet) }
      }
    }
    commonCases.push({ id: caseId, members, packet: reference })
  }
  const result = preparationSchema.parse({
    version,
    manifest_sha256: manifestHash,
    questions_sha256: digest(questions),
    calibration: calibrationReference,
    assignments,
    packet_references: packetReferences,
    pairs,
    pair_packets: pairPackets,
    human_policy: buildHumanSamplePolicy(
      pairs,
      manifest.created_at,
      humanPairs
    ),
    common_cases: commonCases,
    unavailable,
    pair_errors: pairErrors,
  })
  await writeArtifact(dir, `private-review/${version}.json`, result)
  return result
}

/** Replays saved evidence and bound reviewer submissions; never calls a provider. */
export async function recomputeDevelopmentReport(
  dir: string,
  versionInput: string,
  inputValue: unknown
) {
  const version = safeVersion.parse(versionInput)
  const input = developmentReviewInputSchema.parse(inputValue)
  const preparation = preparationSchema.parse(
    await readArtifact(dir, `private-review/${version}.json`)
  )
  if (preparation.version !== version) throw new Error("Review version differs")
  const { manifest, bank: questions } = await loadRoundSnapshot(dir)
  if (
    digest(manifest) !== preparation.manifest_sha256 ||
    digest(questions) !== preparation.questions_sha256
  )
    throw new Error("Review belongs to a different frozen round")
  if (
    digest(await readArtifact(dir, preparation.calibration.file)) !==
    preparation.calibration.sha256
  )
    throw new Error("Calibration packet hash differs")
  const packets = new Map<string, z.infer<typeof judgingPacketSchema>>()
  for (const reference of preparation.packet_references) {
    const packet = judgingPacketSchema.parse(
      await readArtifact(dir, reference.file)
    )
    if (digest(packet) !== reference.sha256)
      throw new Error("Saved judge packet hash differs")
    packets.set(packet.blind_id, packet)
  }
  for (const reference of [
    ...preparation.pair_packets,
    ...preparation.common_cases.flatMap((item) =>
      item.packet === null ? [] : [item.packet]
    ),
  ])
    if (digest(await readArtifact(dir, reference.file)) !== reference.sha256)
      throw new Error("Saved comparison packet hash differs")
  const assessments = []
  const judgeErrors: { blind_id: string; error_kind: string }[] = []
  const seen = new Set<string>()
  for (const submission of input.judge_submissions) {
    const assignment = preparation.assignments.find(
      (candidate) => candidate.blind_id === submission.blind_id
    )
    const packet = packets.get(submission.blind_id)
    if (
      assignment === undefined ||
      packet === undefined ||
      seen.has(submission.blind_id)
    )
      throw new Error("Unplanned or duplicate independent assessment")
    seen.add(submission.blind_id)
    try {
      const plan = manifest.attempts.find(
        (candidate) => candidate.id === assignment.attempt_id
      )
      const question = questions.questions.find(
        (candidate) => candidate.id === assignment.question_id
      )
      if (plan === undefined || question === undefined)
        throw new Error("Stale review binding")
      const reconstructed = prepareJudgingPacket(
        question,
        await loadAttempt(dir, plan),
        manifest.experiment?.judge_max_bytes ?? 1_048_576
      )
      if (
        digest(reconstructed.assignment) !== digest(assignment) ||
        digest(reconstructed.packet) !== digest(packet)
      )
        throw new Error("Evidence changed after preparation")
      assessments.push(
        importJudgeSubmission(submission, { assignment, packet })
      )
    } catch {
      judgeErrors.push({
        blind_id: submission.blind_id,
        error_kind: "invalid_review_binding",
      })
    }
  }
  const core = await recomputeReport(dir, version, assessments)
  const calibration = auditCalibration(
    input.calibrations ?? [],
    preparation.calibration.source_sha256,
    [
      ...input.judge_submissions.map((item) => item.reviewer),
      ...input.pair_judgments.map((item) => item.reviewer),
      ...input.s13_content.map((item) => item.reviewer),
    ]
  )
  const comparison = summarizeComparisons(
    preparation.pairs,
    input.pair_judgments
  )
  const findings = core.attempts.flatMap((attempt) => {
    const evaluation = attempt.evaluation
    if (evaluation === null) return []
    return (["scope", "causality"] as const).flatMap((dimension) => {
      const semanticKeys =
        dimension === "scope"
          ? ([
              "scope",
              "top_n_generalization",
              "out_of_span_zero",
              "denominator",
              "claim_alignment",
            ] as const)
          : (["precursor_causality"] as const)
      const semantic = semanticKeys
        .filter((key) => evaluation.semantic[key].status === "fail")
        .map((key) => ({ dimension: key, finding: evaluation.semantic[key] }))
      const rubric =
        dimension === "scope"
          ? evaluation.rubric?.scope
          : evaluation.rubric?.causal_separation
      if (semantic.length === 0 && rubric?.score !== 0) return []
      return [
        {
          id: `${attempt.attempt_id}-${dimension}`,
          dimension,
          critical: true,
          original: z.json().parse({
            attempt_id: attempt.attempt_id,
            dimension,
            semantic,
            rubric: rubric ?? null,
          }),
        },
      ]
    })
  })
  const human = auditHumanSample({
    policy: preparation.human_policy,
    plans: preparation.pairs,
    summary: comparison,
    findings,
    reviews: input.human_reviews,
  })
  if (
    new Set(input.s13_content.map((content) => content.case_id)).size !==
      input.s13_content.length ||
    input.s13_content.some(
      (content) =>
        !preparation.common_cases.some(
          (common) => common.id === content.case_id
        )
    )
  )
    throw new Error("Unplanned or duplicate S-13 assessment")
  const commonCases = preparation.common_cases.map((common) =>
    evaluateCommonCase({
      id: common.id,
      members: common.members,
      content:
        common.packet === null
          ? undefined
          : input.s13_content.find((content) => content.case_id === common.id),
    })
  )
  const comparisonComplete =
    comparison.totals.planned_pairs > 0 &&
    comparison.totals.missing_pairs === 0 &&
    comparison.totals.invalid_pairs === 0 &&
    comparison.totals.unknown_pairs === 0
  const commonPassed =
    manifest.experiment !== undefined &&
    commonCases.some(
      (common) =>
        common.case_id === manifest.experiment?.common_case &&
        common.status === "pass"
    )
  const failed =
    core.acceptance === "failed" ||
    commonCases.some((common) => common.status === "fail")
  const passed =
    core.acceptance === "pending_external_acceptance" &&
    comparisonComplete &&
    human.status === "pass" &&
    commonPassed &&
    calibration.status === "pass" &&
    judgeErrors.length === 0 &&
    preparation.unavailable.length === 0 &&
    preparation.pair_errors.length === 0
  return {
    version,
    round_id: manifest.round_id,
    manifest_sha256: digest(manifest),
    preparation_sha256: digest(preparation),
    review_input_sha256: digest(input),
    evaluator_sha256: digest(
      await Promise.all(
        ["development.ts", "comparison.ts", "judging.ts", "calibration.ts"].map(
          (file) => readFile(new URL(file, import.meta.url), "utf8")
        )
      )
    ),
    acceptance: failed
      ? ("failed" as const)
      : passed
        ? ("passed" as const)
        : ("not_demonstrated" as const),
    core,
    comparison,
    human,
    common_cases: commonCases,
    calibration,
    judge_errors: judgeErrors,
    unavailable_attempts: preparation.unavailable,
    limitations: [
      "Blinding hides variant labels and author rationale; answer style can still reveal the guidance.",
      "Only saved check_claims results verify numerical claims. Rubric, pair and human judgments remain independent content assessments.",
      "This report covers development only; web-client evidence and holdout acceptance are separate.",
    ],
  }
}

export async function saveDevelopmentReport(
  dir: string,
  version: string,
  input: unknown
) {
  const report = await recomputeDevelopmentReport(dir, version, input)
  await writeArtifact(
    dir,
    `review-input/${safeVersion.parse(version)}.json`,
    input
  )
  await writeArtifact(dir, `development-reports/${version}.json`, report)
  return report
}
