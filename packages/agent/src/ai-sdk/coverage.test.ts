import type { CheckClaimsOutput } from "@workspace/domain/tools/check-claims"
import { describe, expect, it } from "vitest"

import {
  claimsHint,
  coverageHint,
  missingCoverage,
  type CoverageStep,
  type RoleCoverage,
} from "./coverage.ts"

const errorsReq = {
  label: "a count of errors",
  anyOf: [{ tool: "count_events", input: { only_errors: "true" } }],
}
const trendReq = {
  label: "a trend or a context lookup",
  anyOf: [
    { tool: "event_trend" },
    { tool: "get_log_context", input: { mode: "aggregate" } },
  ],
}
const checkReq = { label: "a claim check", anyOf: [{ tool: "check_claims" }] }

const coverage: RoleCoverage = [errorsReq, trendReq, checkReq]

describe("missingCoverage", () => {
  it("is empty when every requirement is satisfied by a successful step", () => {
    const steps: CoverageStep[] = [
      { tool: "count_events", input: { only_errors: true }, ok: true },
      { tool: "event_trend", input: {}, ok: true },
      { tool: "check_claims", input: { claims: [] }, ok: true },
    ]
    expect(missingCoverage(coverage, steps)).toEqual([])
  })

  it("ignores failed steps", () => {
    const steps: CoverageStep[] = [
      { tool: "count_events", input: { only_errors: true }, ok: false },
    ]
    expect(missingCoverage(coverage, steps).map((r) => r.label)).toEqual([
      "a count of errors",
      "a trend or a context lookup",
      "a claim check",
    ])
  })

  it("matches an input value by stringified equality", () => {
    const yes: CoverageStep[] = [
      { tool: "count_events", input: { only_errors: true }, ok: true },
    ]
    const no: CoverageStep[] = [
      { tool: "count_events", input: { only_errors: false }, ok: true },
    ]
    expect(missingCoverage([errorsReq], yes)).toEqual([])
    expect(missingCoverage([errorsReq], no)).toEqual([errorsReq])
  })

  it("matches a `true` requirement as key-present", () => {
    const req: RoleCoverage = [
      {
        label: "scoped count",
        anyOf: [{ tool: "count_events", input: { components: true } }],
      },
    ]
    const present: CoverageStep[] = [
      { tool: "count_events", input: { components: ["KERNEL"] }, ok: true },
    ]
    const absent: CoverageStep[] = [
      { tool: "count_events", input: {}, ok: true },
    ]
    expect(missingCoverage(req, present)).toEqual([])
    expect(missingCoverage(req, absent)).toEqual(req)
  })

  it("is satisfied by either alternative (anyOf)", () => {
    const viaContext: CoverageStep[] = [
      { tool: "get_log_context", input: { mode: "aggregate" }, ok: true },
    ]
    expect(missingCoverage([trendReq], viaContext)).toEqual([])
  })
})

describe("coverageHint", () => {
  it("builds the deterministic English hint with labels joined by '; '", () => {
    const missing: RoleCoverage = [
      { label: "a count of errors", anyOf: [] },
      { label: "a claim check", anyOf: [] },
    ]
    expect(coverageHint(missing)).toBe(
      "Required evidence still missing: a count of errors; a claim check. Fetch it or state in Unknown why it does not apply."
    )
  })

  it("is null when nothing is missing", () => {
    expect(coverageHint([])).toBeNull()
  })
})

function output(mismatch: number, unresolved: number): CheckClaimsOutput {
  return {
    claims: [],
    summary: {
      checked: mismatch + unresolved,
      verified: 0,
      mismatch,
      unresolved,
      text: `line`,
    },
  }
}

describe("claimsHint", () => {
  it("is null when the last check is clean", () => {
    expect(claimsHint(output(0, 0))).toBeNull()
    expect(claimsHint(null)).toBeNull()
  })

  it("names mismatch and unresolved counts", () => {
    const hint = claimsHint(output(2, 1))
    expect(hint).toContain("2 claim(s) mismatch")
    expect(hint).toContain("1 claim(s) cite an unknown fact or receipt")
  })
})
