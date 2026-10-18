import type { CheckClaimsOutput } from "@workspace/domain/tools/check-claims"

/**
 * Coverage evaluation (technical.md § 10 "Coverage", § 11.1 phase `coverage`).
 *
 * LOG-47 is NOT implemented yet: it will add a `## Coverage` section to each
 * role playbook and have `playbooks.ts` parse it into `loadPlaybooks().coverage`
 * keyed by role. These local types describe the shape that `coverage[role]`
 * will produce, so the phase machine can already consume it; once LOG-47 lands,
 * these move to (or are re-exported from) the playbook loader and the duplicate
 * here is removed.
 */

/**
 * One alternative in a requirement: a tool, optionally constrained on input.
 * In `input`, a string means `input[key]` stringifies equal to that value; the
 * literal `true` means the key is present (any value).
 */
export type CoverageAlternative = {
  tool: string
  input?: Record<string, string | true>
}

/** A role's required evidence: a list of requirements, each with alternatives. */
export type RoleCoverage = { label: string; anyOf: CoverageAlternative[] }[]

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
