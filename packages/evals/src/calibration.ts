import { z } from "zod"
import { digest } from "./artifacts.ts"
import { semanticAssessmentSchema } from "./evaluate.ts"

const CONTROLS = {
  valid_control: "pass",
  valid_zero_open_hypothesis: "pass",
  wrong_value: "fail",
  wrong_metric: "fail",
  wrong_group: "fail",
  wrong_scope: "fail",
  top_n_generalization: "fail",
  out_of_span_zero: "fail",
  wrong_denominator: "fail",
  precursor_as_cause: "fail",
  unsupported_hypothesis_status: "fail",
  check_after_recommendation: "fail",
  missing_check_chronology: "unknown",
} as const

export const calibrationSchema = z.strictObject({
  reviewer: semanticAssessmentSchema.shape.reviewer,
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  assessed_at: z.iso.datetime(),
  results: z.array(
    z.strictObject({
      control: z.enum([
        "valid_control",
        "valid_zero_open_hypothesis",
        "wrong_value",
        "wrong_metric",
        "wrong_group",
        "wrong_scope",
        "top_n_generalization",
        "out_of_span_zero",
        "wrong_denominator",
        "precursor_as_cause",
        "unsupported_hypothesis_status",
        "check_after_recommendation",
        "missing_check_chronology",
      ]),
      judgment: z.enum(["pass", "fail", "unknown"]),
      reason: z.string().min(1),
    })
  ),
})

/** Known synthetic LOG-52 controls, provided to the reviewer before real ratings. */
export function calibrationPacket(source: string) {
  return {
    fixture_only: true,
    source_file: "packages/evals/src/evaluate.test.ts",
    source_sha256: digest(source),
    source,
    controls: CONTROLS,
    instructions:
      "Inspect the complete synthetic valid and mutated controls in this LOG-52 source. Report each required control's judgment with a reason, using the saved check_claims outcomes for wrong value/metric/group. An unsupported supported/contradicted hypothesis must fail; valid zero and an open hypothesis can pass. Missing chronology is unknown. Tool existence is not a successful discriminating check. These controls establish calibration only, never real corpus quality. Declare authorship/rationale independence before rating real answers.",
  }
}

export function auditCalibration(
  values: unknown[],
  sourceHash: string,
  reviewers: unknown[]
) {
  const calibrations = values.map((value) => calibrationSchema.parse(value))
  const identities = [
    ...new Set(
      reviewers.map((reviewer) =>
        digest(semanticAssessmentSchema.shape.reviewer.parse(reviewer))
      )
    ),
  ]
  const missing: string[] = [],
    invalid: string[] = []
  for (const identity of identities) {
    const matches = calibrations.filter(
      (item) => digest(item.reviewer) === identity
    )
    const calibration = matches[0]
    if (calibration === undefined) {
      missing.push(identity)
      continue
    }
    if (
      matches.length !== 1 ||
      calibration.source_sha256 !== sourceHash ||
      calibration.results.length !== Object.keys(CONTROLS).length ||
      new Set(calibration.results.map((item) => item.control)).size !==
        calibration.results.length ||
      calibration.results.some(
        (item) => item.judgment !== CONTROLS[item.control]
      )
    )
      invalid.push(identity)
  }
  return {
    status:
      invalid.length > 0
        ? ("fail" as const)
        : identities.length === 0 || missing.length > 0
          ? ("unknown" as const)
          : ("pass" as const),
    required_reviewers: identities.length,
    missing,
    invalid,
    original_calibrations: calibrations,
  }
}
