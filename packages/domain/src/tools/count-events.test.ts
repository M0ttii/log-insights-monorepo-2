import { describe, expect, it } from "vitest"
import { z } from "zod"

import type { ToolResult } from "../tool.ts"
import {
  countEventsFactSpecs,
  countEventsInputSchema,
  countEventsOutputSchema,
  countGroupSchema,
  countsApiAccesses,
  summarizeCountEvents,
  type CountEventsOutput,
} from "./count-events.ts"

const parse = (input: unknown) => countEventsInputSchema.safeParse(input)

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("not an object")
  return Object.fromEntries(Object.entries(value))
}

describe("countEventsInputSchema", () => {
  it("resolves the default top_n", () => {
    expect(countEventsInputSchema.parse({ group_by: ["team"] })).toEqual({
      group_by: ["team"],
      top_n: 20,
    })
  })

  it("takes 1–2 known dimensions and top_n 1–50", () => {
    expect(parse({ group_by: [] }).success).toBe(false)
    expect(parse({ group_by: ["dataset", "team", "level"] }).success).toBe(
      false
    )
    expect(parse({ group_by: ["message"] }).success).toBe(false)
    expect(parse({}).success).toBe(false)
    expect(parse({ group_by: ["dataset", "team"] }).success).toBe(true)
    expect(parse({ group_by: ["level"], top_n: 0 }).success).toBe(false)
    expect(parse({ group_by: ["level"], top_n: 51 }).success).toBe(false)
    expect(parse({ group_by: ["level"], top_n: 50 }).success).toBe(true)
  })

  it("takes compare as previous_period or a strict {from, to}", () => {
    expect(
      parse({ group_by: ["level"], compare: "previous_period" }).success
    ).toBe(true)
    expect(
      parse({
        group_by: ["level"],
        compare: { from: "2005-07-01T00:00:00Z", to: "2005-08-01T00:00:00Z" },
      }).success
    ).toBe(true)
    expect(parse({ group_by: ["level"], compare: "previous" }).success).toBe(
      false
    )
    expect(
      parse({
        group_by: ["level"],
        compare: { from: "2005-07-01T00:00:00Z" },
      }).success
    ).toBe(false)
    expect(
      parse({
        group_by: ["level"],
        compare: {
          from: "2005-07-01T00:00:00Z",
          to: "2005-08-01T00:00:00Z",
          slop: 1,
        },
      }).success
    ).toBe(false)
  })

  it("accepts every shared filter and rejects unknown fields", () => {
    expect(
      parse({
        group_by: ["component"],
        text: "cache parity",
        pattern_id: "0123456789abcdef",
        only_errors: true,
      }).success
    ).toBe(true)
    expect(parse({ group_by: ["component"], foo: 1 }).success).toBe(false)
  })

  it("exports a strict JSON Schema with a description on every field", () => {
    for (const [schema, io] of [
      [countEventsInputSchema, "input"],
      [countEventsOutputSchema, "output"],
      [countGroupSchema, "output"],
    ] as const) {
      const json = z.toJSONSchema(schema, { io })
      expect(json.additionalProperties).toBe(false)
      const undescribed = Object.entries(asObject(json.properties))
        .filter(
          ([, property]) => typeof asObject(property).description !== "string"
        )
        .map(([name]) => name)
      expect(undescribed).toEqual([])
    }
    const input = z.toJSONSchema(countEventsInputSchema, { io: "input" })
    expect(input.required).toEqual(["group_by"])
    expect(asObject(asObject(input.properties).group_by)).toMatchObject({
      minItems: 1,
      maxItems: 2,
    })
  })
})

describe("countEventsFactSpecs", () => {
  it("groups facts by the group_by dimensions", () => {
    const specs = countEventsFactSpecs({ group_by: ["dataset", "team"] })
    expect(specs.find((s) => s.path === "/result/groups/*/events")).toEqual({
      path: "/result/groups/*/events",
      metric: "events",
      unit: "log_events",
      groupKeys: ["dataset", "team"],
    })
    expect(specs.find((s) => s.path === "/result/total")).toMatchObject({
      metric: "events",
      groupKeys: [],
    })
  })

  it("adds B, delta and change per group, other and total with compare", () => {
    const specs = countEventsFactSpecs({
      group_by: ["component"],
      compare: "previous_period",
    })
    expect(
      specs
        .filter((s) => s.path.startsWith("/result/"))
        .map((s) => [s.path, s.metric, s.unit, s.groupKeys.join(",")])
    ).toEqual([
      ["/result/total", "events_current", "log_events", ""],
      ["/result/group_count", "groups", "groups", ""],
      ["/result/groups/*/events", "events_current", "log_events", "component"],
      ["/result/groups/*/share", "share", "ratio", "component"],
      [
        "/result/groups/*/baseline",
        "events_baseline",
        "log_events",
        "component",
      ],
      ["/result/groups/*/delta", "delta", "log_events", "component"],
      ["/result/groups/*/pct_change", "pct_change", "percent", "component"],
      ["/result/other/groups", "other_groups", "groups", ""],
      ["/result/other/events", "other_events_current", "log_events", ""],
      ["/result/other/share", "other_share", "ratio", ""],
      ["/result/other/baseline", "other_events_baseline", "log_events", ""],
      ["/result/other/delta", "other_delta", "log_events", ""],
      ["/result/other/pct_change", "other_pct_change", "percent", ""],
      ["/result/comparison/baseline", "events_baseline", "log_events", ""],
      ["/result/comparison/delta", "delta", "log_events", ""],
      ["/result/comparison/pct_change", "pct_change", "percent", ""],
    ])
    expect(
      specs.find((s) => s.path === "/scope/windows/*/from")?.groupKeys
    ).toEqual(["dataset", "period"])
  })

  it("names API accesses as metric and unit for http_status and endpoint", () => {
    expect(countsApiAccesses(["component", "endpoint"])).toBe(true)
    expect(countsApiAccesses(["component", "node"])).toBe(false)
    const specs = countEventsFactSpecs({ group_by: ["http_status"] })
    expect(
      specs
        .filter((s) => s.path.includes("events") || s.path === "/result/total")
        .map((s) => [s.path, s.metric, s.unit])
    ).toEqual([
      ["/result/total", "api_accesses", "api_accesses"],
      ["/result/groups/*/events", "api_accesses", "api_accesses"],
      ["/result/other/events", "other_api_accesses", "api_accesses"],
    ])
  })
})

const RECEIPT = "r_0123abcd"

function result(
  data: CountEventsOutput,
  facts: ToolResult<CountEventsOutput>["facts"] = []
): ToolResult<CountEventsOutput> {
  return {
    data,
    facts,
    receipt: {
      receipt_id: RECEIPT,
      input: {},
      signature: "0".repeat(64),
      data_version: "dv_test",
      sql: [],
      params: [],
      scope: {
        windows: [
          {
            dataset: "bgl",
            from: "2005-08-01T00:00:00Z",
            to: "2005-09-01T00:00:00Z",
            period: "current",
          },
          {
            dataset: "bgl",
            from: "2005-07-01T00:00:00.000000Z",
            to: "2005-08-01T00:00:00.000000Z",
            period: "baseline",
          },
        ],
        filters: {},
      },
      population: { count: data.total, unit: data.unit },
      rows_returned: data.groups.length,
      truncated: data.truncated,
      duration_ms: 1,
      result_digest: "0".repeat(64),
    },
    notes: [],
  }
}

function fact(n: number, path: string, value: number) {
  return {
    id: `${RECEIPT}.f${n}`,
    path,
    value,
    metric: "m",
    unit: "u",
    group: {},
  }
}

describe("summarizeCountEvents", () => {
  it("states C, B, delta, change and classification with fact IDs", () => {
    const text = summarizeCountEvents(
      result(
        {
          group_by: ["component"],
          unit: "log_events",
          total: 177,
          group_count: 2,
          groups: [
            {
              component: "KERNEL",
              events: 123,
              share: 0.6949152542372882,
              baseline: 696,
              delta: -573,
              pct_change: -82.32758620689656,
              classification: null,
            },
            {
              component: "MMCS",
              events: 9,
              share: 0.05084745762711865,
              baseline: 0,
              delta: 9,
              pct_change: null,
              classification: "first observed in this comparison",
            },
          ],
          other: null,
          comparison: {
            reference: "previous_period",
            coverage: { current: "full", baseline: "full" },
            determinable: true,
            baseline: 702,
            delta: -525,
            pct_change: -74.78632478632478,
            classification: null,
          },
          truncated: false,
          top_n: 20,
        },
        [
          fact(1, "/result/comparison/baseline", 702),
          fact(2, "/result/groups/0/events", 123),
          fact(3, "/result/groups/0/pct_change", -82.32758620689656),
        ]
      )
    )
    expect(text.split("\n")).toEqual([
      "count_events by component compared with previous period · receipt r_0123abcd",
      "Scope: bgl current [2005-08-01T00:00:00Z, 2005-09-01T00:00:00Z), bgl baseline [2005-07-01T00:00:00.000000Z, 2005-08-01T00:00:00.000000Z).",
      "177 log events in scope in 2 groups; 2 shown, truncated: false; baseline 702 [r_0123abcd.f1], delta -525, -74.79 %.",
      "Coverage: current full, baseline full; determinable: true.",
      '1. component="KERNEL": 123 [r_0123abcd.f2] (69.49 %); baseline 696, delta -573, -82.33 % [r_0123abcd.f3]',
      '2. component="MMCS": 9 (5.08 %); baseline 0, delta +9, no relative change (B = 0), first observed in this comparison',
    ])
  })

  it("says when the baseline is not determinable", () => {
    const text = summarizeCountEvents(
      result({
        group_by: ["level"],
        unit: "log_events",
        total: 4,
        group_count: 1,
        groups: [
          {
            level: "INFO",
            events: 4,
            share: 1,
            baseline: null,
            delta: null,
            pct_change: null,
            classification: null,
          },
        ],
        other: null,
        comparison: {
          reference: "previous_period",
          coverage: { current: "partial", baseline: "none" },
          determinable: false,
          baseline: null,
          delta: null,
          pct_change: null,
          classification: null,
        },
        truncated: false,
        top_n: 20,
      })
    )
    expect(text).toContain(
      '1. level="INFO": 4 (100 %); baseline not determinable'
    )
  })
})
