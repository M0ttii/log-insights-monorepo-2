import type { Dataset } from "@workspace/domain/datasets"
import type { CheckClaimsOutput } from "@workspace/domain/tools/check-claims"
import { describe, expect, it } from "vitest"
import { loadPlaybooks } from "../playbooks.ts"

import {
  applicableCoverage,
  claimsHint,
  coverageHint,
  missingCoverage,
  unavailableCoverageHint,
  type CoverageContext,
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

function capabilityContext(dataset: Dataset): CoverageContext {
  const external = dataset === "otel" || dataset === "otel_replay"
  return {
    datasets: [
      {
        dataset,
        storage:
          dataset === "otel"
            ? "remote_parquet"
            : dataset === "otel_replay"
              ? "otlp_replay"
              : "log_events",
        capabilities: {
          error_definition: "Logged errors",
          only_errors: true,
          investigation_order: !external,
          breadth_unit:
            dataset === "bgl"
              ? "nodes"
              : dataset === "openstack"
                ? "instances"
                : null,
          context_scopes: ["same_component", "dataset"],
          api_accesses: dataset === "openstack",
          labels: null,
          patterns: !external,
          full_text: dataset === "otel" ? "reference_window" : "all",
          direct_scan:
            dataset === "otel" ? { max_seconds: 60, max_files: 2 } : null,
        },
      },
    ],
    selected: [dataset],
  }
}

describe("missingCoverage", () => {
  it("keeps OTel evidence and limitations required in a mixed BGL/OTel request", () => {
    const context: CoverageContext = {
      datasets: [
        ...capabilityContext("bgl").datasets,
        ...capabilityContext("otel").datasets,
      ],
      selected: ["bgl", "otel"],
    }
    const coverageSteps: CoverageStep[] = [
      {
        tool: "recurring_patterns",
        input: { dataset: "bgl", rank: "investigation_order" },
        datasets: ["bgl"],
        ok: true,
      },
      {
        tool: "count_events",
        input: { dataset: "bgl", compare: "previous_period" },
        datasets: ["bgl"],
        ok: true,
      },
      { tool: "check_claims", input: {}, ok: true },
    ]
    const manager = loadPlaybooks().coverage.manager
    expect(
      missingCoverage(manager, coverageSteps, context).some((item) =>
        item.anyOf.some((alternative) => alternative.tool === "event_trend")
      )
    ).toBe(true)
    expect(
      applicableCoverage(manager, context).unavailable.some(
        (label) =>
          label.includes("otel") && label.includes("investigation_order")
      )
    ).toBe(true)
  })

  it("satisfies mixed manager evidence per dataset and checks claims once for the run", () => {
    const context: CoverageContext = {
      datasets: [
        ...capabilityContext("bgl").datasets,
        ...capabilityContext("otel").datasets,
      ],
      selected: ["bgl", "otel"],
    }
    const manager = loadPlaybooks().coverage.manager
    const steps: CoverageStep[] = [
      {
        tool: "recurring_patterns",
        input: { dataset: "bgl", rank: "investigation_order" },
        datasets: ["bgl"],
        ok: true,
      },
      {
        tool: "count_events",
        input: { dataset: "bgl", compare: "previous_period" },
        datasets: ["bgl"],
        ok: true,
      },
      { tool: "count_events", input: { dataset: "otel" }, ok: true },
      { tool: "event_trend", input: {}, datasets: ["otel"], ok: true },
      { tool: "check_claims", input: { claims: [] }, ok: true },
    ]
    expect(missingCoverage(manager, steps, context)).toEqual([])
    const applicable = applicableCoverage(manager, context)
    expect(applicable.unavailable).toEqual([
      "otel: recurring_patterns rank=investigation_order",
      "otel: count_events with compare",
      "otel: one of: recurring_patterns dataset=bgl | latency_stats",
    ])
    expect(
      applicable.required.filter((requirement) =>
        requirement.anyOf.some(
          (alternative) => alternative.tool === "check_claims"
        )
      )
    ).toEqual([{ label: "check_claims", anyOf: [{ tool: "check_claims" }] }])
    expect(
      missingCoverage(
        manager,
        steps.filter((step) => step.tool !== "check_claims"),
        context
      ).map((requirement) => requirement.label)
    ).toEqual(["check_claims"])
  })

  it("does not use another dataset's receipt to satisfy a mixed-scope fallback", () => {
    const context: CoverageContext = {
      datasets: [
        ...capabilityContext("bgl").datasets,
        ...capabilityContext("otel").datasets,
      ],
      selected: ["bgl", "otel"],
    }
    const steps: CoverageStep[] = [
      {
        tool: "recurring_patterns",
        input: { dataset: "bgl", rank: "investigation_order" },
        ok: true,
      },
      {
        tool: "count_events",
        input: { compare: "previous_period" },
        datasets: ["bgl"],
        ok: true,
      },
      { tool: "count_events", input: {}, datasets: ["otel"], ok: true },
      { tool: "event_trend", input: {}, datasets: ["bgl"], ok: true },
      { tool: "check_claims", input: {}, ok: true },
    ]
    expect(
      missingCoverage(loadPlaybooks().coverage.manager, steps, context).map(
        (requirement) => requirement.label
      )
    ).toEqual(["otel: event_trend"])
  })

  it("matches anchor-only context receipts independently for each selected dataset", () => {
    const context: CoverageContext = {
      datasets: [
        ...capabilityContext("bgl").datasets,
        ...capabilityContext("otel").datasets,
      ],
      selected: ["bgl", "otel"],
    }
    const requirement: RoleCoverage = [
      {
        label: "event context",
        anyOf: [{ tool: "get_log_context", input: { mode: "event" } }],
      },
    ]
    const bgl: CoverageStep = {
      tool: "get_log_context",
      input: { mode: "event", event_id: "1" },
      datasets: ["bgl"],
      ok: true,
    }
    const otel: CoverageStep = {
      tool: "get_log_context",
      input: { mode: "event", event_id: "1000000000010" },
      datasets: ["otel"],
      ok: true,
    }
    expect(
      missingCoverage(requirement, [bgl], context).map((item) => item.label)
    ).toEqual(["otel: event context"])
    expect(missingCoverage(requirement, [bgl, otel], context)).toEqual([])
    expect(
      missingCoverage(requirement, [bgl, { ...otel, ok: false }], context).map(
        (item) => item.label
      )
    ).toEqual(["otel: event context"])
  })

  it("recognizes an anchor-only event context through its resolved receipt datasets", () => {
    const requirement: RoleCoverage = [
      {
        label: "event context",
        anyOf: [{ tool: "get_log_context", input: { mode: "event" } }],
      },
    ]
    expect(
      missingCoverage(
        requirement,
        [
          {
            tool: "get_log_context",
            input: { mode: "event", event_id: "1000000000010" },
            ok: true,
            datasets: ["otel"],
          },
        ],
        capabilityContext("otel")
      )
    ).toEqual([])
  })

  it.each(["otel", "otel_replay"] as const)(
    "uses available scoped evidence for %s without accepting unrelated tools",
    (dataset) => {
      const steps: CoverageStep[] = [
        { tool: "count_events", input: { dataset }, ok: true },
        { tool: "event_trend", input: { dataset }, ok: true },
        { tool: "check_claims", input: { claims: [] }, ok: true },
      ]
      const context = capabilityContext(dataset)
      const source = loadPlaybooks()
      expect(
        missingCoverage(source.coverage.team_lead, steps, context)
      ).toEqual([])
      expect(missingCoverage(source.coverage.manager, steps, context)).toEqual(
        []
      )
      expect(
        missingCoverage(
          source.coverage.manager,
          [
            {
              tool: "recurring_patterns",
              input: { dataset: "bgl", rank: "investigation_order" },
              ok: true,
            },
            {
              tool: "count_events",
              input: { dataset: "bgl", compare: "previous_period" },
              ok: true,
            },
            {
              tool: "latency_stats",
              input: { dataset: "openstack" },
              ok: true,
            },
            { tool: "check_claims", input: { claims: [] }, ok: true },
          ],
          context
        ).map((requirement) => requirement.label)
      ).toEqual(["event_trend", "count_events"])
    }
  )

  it.each(["bgl", "openstack"] as const)(
    "keeps full supported-dataset coverage for %s and never uses its fallback",
    (dataset) => {
      const context = capabilityContext(dataset)
      const source = loadPlaybooks()
      const incomplete: CoverageStep[] = [
        { tool: "event_trend", input: { dataset }, ok: true },
        { tool: "count_events", input: { dataset }, ok: true },
        { tool: "check_claims", input: { claims: [] }, ok: true },
      ]
      expect(
        missingCoverage(source.coverage.manager, incomplete, context).map(
          (item) => item.label
        )
      ).toEqual([
        "recurring_patterns rank=investigation_order",
        "count_events with compare",
        "one of: recurring_patterns dataset=bgl | latency_stats",
      ])
      expect(
        missingCoverage(source.coverage.team_lead, incomplete, context).map(
          (item) => item.label
        )
      ).toEqual(["recurring_patterns", "count_events with compare"])
      const complete: CoverageStep[] = [
        ...incomplete,
        {
          tool: "recurring_patterns",
          input: { dataset, rank: "investigation_order" },
          ok: true,
        },
        {
          tool: "count_events",
          input: { dataset, compare: "previous_period" },
          ok: true,
        },
        { tool: "latency_stats", input: {}, ok: true },
      ]
      expect(
        missingCoverage(source.coverage.manager, complete, context)
      ).toEqual([])
      expect(
        missingCoverage(source.coverage.team_lead, complete, context)
      ).toEqual([])
      expect(
        applicableCoverage(source.coverage.manager, context).unavailable
      ).toEqual([])
    }
  )

  it("retains supported requirements in a mixed scope and with missing capability metadata", () => {
    const source = loadPlaybooks()
    const context: CoverageContext = {
      datasets: [
        ...capabilityContext("bgl").datasets,
        ...capabilityContext("otel").datasets,
      ],
      selected: ["bgl", "otel"],
    }
    const otelOnly: CoverageStep[] = [
      { tool: "count_events", input: { dataset: "otel" }, ok: true },
      { tool: "event_trend", input: { dataset: "otel" }, ok: true },
      { tool: "check_claims", input: { claims: [] }, ok: true },
    ]
    expect(
      missingCoverage(source.coverage.team_lead, otelOnly, context).map(
        (item) => item.label
      )
    ).toEqual([
      "bgl: recurring_patterns",
      "bgl: event_trend",
      "bgl: count_events",
      "bgl: count_events with compare",
    ])
    expect(
      missingCoverage(source.coverage.team_lead, otelOnly, {
        datasets: [],
        selected: ["otel"],
      }).map((item) => item.label)
    ).toEqual(["recurring_patterns", "count_events with compare"])
  })

  it("requires successful explicit OTel calls and the claim check after capability filtering", () => {
    const source = loadPlaybooks()
    const context = capabilityContext("otel")
    expect(
      missingCoverage(
        source.coverage.team_lead,
        [
          { tool: "count_events", input: {}, ok: true },
          { tool: "event_trend", input: { dataset: "otel" }, ok: false },
          { tool: "check_claims", input: { claims: [] }, ok: false },
        ],
        context
      ).map((item) => item.label)
    ).toEqual(["event_trend", "count_events", "check_claims"])
  })

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
  it("names unavailable evidence without asking for an impossible or unrelated call", () => {
    const { unavailable } = applicableCoverage(
      loadPlaybooks().coverage.manager,
      capabilityContext("otel")
    )
    const hint = unavailableCoverageHint(unavailable)
    expect(hint).toContain("recurring_patterns rank=investigation_order")
    expect(hint).toContain("count_events with compare")
    expect(hint).toContain("Unknown")
    expect(hint).toContain("not a full role-contract pass")
    expect(hint).toContain("manager priority remains undetermined")
    expect(unavailableCoverageHint([])).toBeNull()
  })
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
