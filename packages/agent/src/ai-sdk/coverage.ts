import type { CheckClaimsOutput } from "@workspace/domain/tools/check-claims"
import type { CoverageAlternative, RoleCoverage } from "../playbooks.ts"

export type { CoverageAlternative, RoleCoverage } from "../playbooks.ts"

/**
 * Coverage evaluation (technical.md § 10 "Coverage", § 11.1 phase `coverage`).
 *
 * Requirements and their Zod-derived types come from the playbook loader;
 * the phase machine only checks successful tool steps against them.
 */

/** A step the model took, as the phase machine records it for coverage. */
export type CoverageStep = {
  tool: string
  input: unknown
  /** Whether the step succeeded (only successful steps satisfy a requirement). */
  ok: boolean
}

/** Reads `input[key]` from an unknown step input, or undefined. */
function readInput(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null) return undefined
  return (input as Record<string, unknown>)[key]
}

/** Does one successful step satisfy one alternative? */
function stepSatisfies(step: CoverageStep, alt: CoverageAlternative): boolean {
  if (!step.ok || step.tool !== alt.tool) return false
  if (alt.input === undefined) return true
  for (const [key, expected] of Object.entries(alt.input)) {
    const actual = readInput(step.input, key)
    if (expected === true) {
      // Key must be present with a non-undefined value.
      if (actual === undefined) return false
    } else {
      // Value must stringify equal to the expected value.
      if (actual === undefined || String(actual) !== expected) return false
    }
  }
  return true
}

/**
 * Requirements not satisfied by any successful step. Deterministic: the result
 * keeps the order of `coverage`, and a requirement is satisfied as soon as one
 * of its alternatives matches one successful step.
 */
export function missingCoverage(
  coverage: RoleCoverage,
  steps: CoverageStep[]
): RoleCoverage {
  return coverage.filter(
    (requirement) =>
      !requirement.anyOf.some((alt) =>
        steps.some((step) => stepSatisfies(step, alt))
      )
  )
}

/**
 * The deterministic English system hint for missing coverage (technical.md
 * § 11.1 phase `coverage`). Labels are joined with "; ". Returns `null` when
 * nothing is missing, so the caller skips the re-investigation.
 */
export function coverageHint(missing: RoleCoverage): string | null {
  if (missing.length === 0) return null
  const labels = missing.map((requirement) => requirement.label).join("; ")
  return `Required evidence still missing: ${labels}. Fetch it or state in Unknown why it does not apply.`
}

/**
 * The deterministic English system hint for mismatched or unresolved claims in
 * the last `check_claims` result (technical.md § 11.1 phase `coverage`). The
 * counts come from the check_claims output schema in
 * `@workspace/domain/tools/check-claims`. Returns `null` when the last check
 * had no mismatch and no unresolved claim.
 */
export function claimsHint(last: CheckClaimsOutput | null): string | null {
  if (last === null) return null
  const { mismatch, unresolved } = last.summary
  if (mismatch === 0 && unresolved === 0) return null
  const parts: string[] = []
  if (mismatch > 0) parts.push(`${mismatch} claim(s) mismatch their cited fact`)
  if (unresolved > 0)
    parts.push(`${unresolved} claim(s) cite an unknown fact or receipt`)
  return `Claim check not clean: ${parts.join("; ")}. Correct or drop these numbers before answering, or re-fetch the evidence.`
}
