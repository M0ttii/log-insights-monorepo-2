import { describeCorpusOutputSchema } from "@workspace/analytics/registry"
import type { Dataset } from "@workspace/domain/datasets"
import type { CheckClaimsOutput } from "@workspace/domain/tools/check-claims"
import { z } from "zod"
import type { CoverageAlternative, RoleCoverage } from "../playbooks.ts"

export type { CoverageAlternative, RoleCoverage } from "../playbooks.ts"

/** A projection of the canonical tool output, never a parallel capability DTO. */
export const coverageCorpusSchema = z.object({
  datasets: z.array(
    describeCorpusOutputSchema.shape.datasets.element.pick({
      dataset: true,
      storage: true,
      capabilities: true,
    })
  ),
})
type CoverageDataset = z.infer<typeof coverageCorpusSchema>["datasets"][number]
export type CoverageContext = z.infer<typeof coverageCorpusSchema> & {
  selected?: Dataset[]
}

function selectedDatasets(context: CoverageContext): CoverageDataset[] {
  return context.datasets.filter((dataset) =>
    context.selected === undefined
      ? dataset.storage === "log_events"
      : context.selected.includes(dataset.dataset)
  )
}

function supports(dataset: CoverageDataset, alternative: CoverageAlternative) {
  const { tool, input } = alternative
  if (input?.dataset !== undefined && input.dataset !== dataset.dataset)
    return false
  if (tool === "recurring_patterns")
    return (
      dataset.capabilities.patterns &&
      (input?.rank !== "investigation_order" ||
        dataset.capabilities.investigation_order)
    )
  if (tool === "get_log_context" && input?.mode === "aggregate")
    return dataset.capabilities.patterns
  if (tool === "latency_stats") return dataset.capabilities.api_accesses
  if (tool === "count_events" && input?.compare !== undefined)
    return dataset.storage === "log_events"
  return true
}

type ScopedRequirement = {
  requirement: RoleCoverage[number]
  dataset?: CoverageDataset
}

/** Keep the dataset binding internal so public playbook contracts stay unchanged. */
function scopedCoverage(
  coverage: RoleCoverage,
  context?: CoverageContext
): { required: ScopedRequirement[]; unavailable: string[] } {
  const datasets = context === undefined ? [] : selectedDatasets(context)
  // Failed/missing preflight metadata never grants a capability exemption.
  if (datasets.length === 0)
    return {
      required: coverage.map((requirement) => ({ requirement })),
      unavailable: [],
    }
  const required: ScopedRequirement[] = []
  const unavailable: string[] = []
  for (const requirement of coverage) {
    // A claim check verifies the answer's facts across all selected datasets.
    if (
      requirement.anyOf.every(
        (alternative) => alternative.tool === "check_claims"
      )
    ) {
      required.push({ requirement })
      continue
    }
    for (const dataset of datasets) {
      const qualify = (label: string) =>
        datasets.length > 1 ? `${dataset.dataset}: ${label}` : label
      const anyOf = requirement.anyOf.filter((alternative) =>
        supports(dataset, alternative)
      )
      if (anyOf.length > 0)
        required.push({
          dataset,
          requirement: {
            ...requirement,
            label: qualify(requirement.label),
            anyOf,
          },
        })
      else {
        unavailable.push(qualify(requirement.label))
        const { fallback } = requirement
        if (fallback !== undefined && supports(dataset, fallback))
          required.push({
            dataset,
            requirement: { label: qualify(fallback.tool), anyOf: [fallback] },
          })
      }
    }
  }
  return { required, unavailable }
}

/** Unsupported checks remain explicit limitations; a fallback is not that check. */
export function applicableCoverage(
  coverage: RoleCoverage,
  context?: CoverageContext
): { required: RoleCoverage; unavailable: string[] } {
  const { required, unavailable } = scopedCoverage(coverage, context)
  return {
    required: required.map((entry) => entry.requirement),
    unavailable,
  }
}

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
  /** Actual datasets from the successful receipt, including resolved anchors. */
  datasets?: Dataset[]
  /** Whether the step succeeded (only successful steps satisfy a requirement). */
  ok: boolean
}

/** Reads `input[key]` from an unknown step input, or undefined. */
function readInput(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null) return undefined
  return (input as Record<string, unknown>)[key]
}

function stepCoversDataset(
  step: CoverageStep,
  entry: CoverageDataset
): boolean {
  const dataset = readInput(step.input, "dataset")
  if (dataset !== undefined) return dataset === entry.dataset
  if (step.datasets !== undefined && step.datasets.length > 0)
    return step.datasets.includes(entry.dataset)
  if (step.tool === "latency_stats") return entry.capabilities.api_accesses
  return entry.storage === "log_events"
}

/** Does one successful step satisfy one alternative? */
function stepSatisfies(
  step: CoverageStep,
  alt: CoverageAlternative,
  dataset?: CoverageDataset
): boolean {
  if (!step.ok || step.tool !== alt.tool) return false
  // A successful step covers only this requirement's dataset, never another
  // selected dataset that happens to support the same tool.
  if (
    dataset !== undefined &&
    step.tool !== "check_claims" &&
    (!supports(dataset, alt) || !stepCoversDataset(step, dataset))
  )
    return false
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
  steps: CoverageStep[],
  context?: CoverageContext
): RoleCoverage {
  return scopedCoverage(coverage, context)
    .required.filter(
      ({ requirement, dataset }) =>
        !requirement.anyOf.some((alt) =>
          steps.some((step) => stepSatisfies(step, alt, dataset))
        )
    )
    .map((entry) => entry.requirement)
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

export function unavailableCoverageHint(unavailable: string[]): string | null {
  if (unavailable.length === 0) return null
  return `Required evidence unavailable for the selected dataset capabilities: ${unavailable.join("; ")}. Name these omitted checks in Unknown and keep their conclusions open. Available evidence is not a full role-contract pass. Do not fetch unrelated datasets to satisfy coverage; manager priority remains undetermined without investigation order, episodes and breadth.`
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
