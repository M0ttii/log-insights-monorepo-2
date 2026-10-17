import { describe, expect, it } from "vitest"

import {
  buildFacts,
  CITATION_EXAMPLE,
  formatCitation,
  formatFactValue,
  type FactSpec,
} from "./facts.ts"

const RECEIPT = "r_7f3a9c21"

const scope = {
  windows: [
    {
      dataset: "bgl",
      from: "2005-06-03T00:00:00Z",
      to: "2005-06-10T00:00:00Z",
    },
  ],
  filters: {},
}

const groupSpecs: FactSpec[] = [
  {
    path: "/result/groups/*/events",
    metric: "events",
    unit: "log_events",
    groupKeys: ["dataset", "team"],
  },
  {
    path: "/result/groups/*/share",
    metric: "share",
    unit: "ratio",
    groupKeys: ["dataset", "team"],
  },
  {
    path: "/result/total",
    metric: "events",
    unit: "log_events",
    groupKeys: [],
  },
  {
    path: "/scope/windows/*/from",
    metric: "window_start",
    unit: "instant",
    groupKeys: ["dataset"],
  },
]

function spec(path: string, groupKeys: string[] = []): FactSpec {
  return { path, metric: "m", unit: "u", groupKeys }
}

describe("buildFacts", () => {
  it("numbers result before scope, keys in code-point order, arrays by index", () => {
    // Keys deliberately out of order: the walk sorts them.
    const result = {
      total: 3000,
      other: null,
      groups: [
        {
          team: "Compute Platform",
          events: 1204,
          dataset: "bgl",
          share: 0.4013,
        },
        { share: 0.1, dataset: "bgl", team: "Storage", events: 300 },
      ],
    }
    expect(buildFacts(RECEIPT, { result, scope }, groupSpecs)).toEqual([
      {
        id: "r_7f3a9c21.f1",
        path: "/result/groups/0/events",
        value: 1204,
        metric: "events",
        unit: "log_events",
        group: { dataset: "bgl", team: "Compute Platform" },
      },
      {
        id: "r_7f3a9c21.f2",
        path: "/result/groups/0/share",
        value: 0.4013,
        metric: "share",
        unit: "ratio",
        group: { dataset: "bgl", team: "Compute Platform" },
      },
      {
        id: "r_7f3a9c21.f3",
        path: "/result/groups/1/events",
        value: 300,
        metric: "events",
        unit: "log_events",
        group: { dataset: "bgl", team: "Storage" },
      },
      {
        id: "r_7f3a9c21.f4",
        path: "/result/groups/1/share",
        value: 0.1,
        metric: "share",
        unit: "ratio",
        group: { dataset: "bgl", team: "Storage" },
      },
      {
        id: "r_7f3a9c21.f5",
        path: "/result/total",
        value: 3000,
        metric: "events",
        unit: "log_events",
        group: {},
      },
      {
        id: "r_7f3a9c21.f6",
        path: "/scope/windows/0/from",
        value: "2005-06-03T00:00:00Z",
        metric: "window_start",
        unit: "instant",
        group: { dataset: "bgl" },
      },
    ])
  })

  it("gives null values no fact and leaves null dimensions out of the group", () => {
    const result = {
      groups: [{ dataset: "bgl", team: null, events: 7, share: null }],
      total: null,
    }
    expect(buildFacts(RECEIPT, { result, scope: {} }, groupSpecs)).toEqual([
      {
        id: "r_7f3a9c21.f1",
        path: "/result/groups/0/events",
        value: 7,
        metric: "events",
        unit: "log_events",
        group: { dataset: "bgl" },
      },
    ])
  })

  it("takes group keys from enclosing rows of nested arrays", () => {
    const result = {
      buckets: [
        {
          bucket: "2005-06-03T00:00:00.000000Z",
          series: [
            { name: "KERNEL", count: 2 },
            { name: "APP", count: 0 },
          ],
        },
      ],
    }
    const specs: FactSpec[] = [
      {
        path: "/result/buckets/*/bucket",
        metric: "bucket_start",
        unit: "instant",
        groupKeys: [],
      },
      {
        path: "/result/buckets/*/series/*/count",
        metric: "events",
        unit: "log_events",
        groupKeys: ["bucket", "name"],
      },
    ]
    const facts = buildFacts(RECEIPT, { result, scope: {} }, specs)
    expect(
      facts.map((fact) => [fact.id, fact.path, fact.value, fact.group])
    ).toEqual([
      [
        "r_7f3a9c21.f1",
        "/result/buckets/0/bucket",
        "2005-06-03T00:00:00.000000Z",
        {},
      ],
      [
        "r_7f3a9c21.f2",
        "/result/buckets/0/series/0/count",
        2,
        { bucket: "2005-06-03T00:00:00.000000Z", name: "KERNEL" },
      ],
      [
        "r_7f3a9c21.f3",
        "/result/buckets/0/series/1/count",
        0,
        { bucket: "2005-06-03T00:00:00.000000Z", name: "APP" },
      ],
    ])
  })

  it("gives fields without a spec no ID", () => {
    expect(
      buildFacts(RECEIPT, { result: { total: 1, shown: 1 }, scope: {} }, [])
    ).toEqual([])
  })

  it("throws on spec bugs", () => {
    const source = {
      result: { groups: [{ team: "A", events: 1, label: "x", flag: true }] },
      scope: {},
    }
    expect(() => buildFacts(RECEIPT, source, [spec("/result/groups")])).toThrow(
      /array/
    )
    expect(() =>
      buildFacts(RECEIPT, source, [spec("/result/groups/*")])
    ).toThrow(/object/)
    expect(() =>
      buildFacts(RECEIPT, source, [spec("/result/groups/*/label")])
    ).toThrow(/ISO-8601/)
    expect(() =>
      buildFacts(RECEIPT, source, [spec("/result/groups/*/flag")])
    ).toThrow(/ISO-8601/)
    expect(() =>
      buildFacts(RECEIPT, source, [
        spec("/result/groups/*/events", ["dataset"]),
      ])
    ).toThrow(/dataset/)
    expect(() =>
      buildFacts(RECEIPT, source, [
        spec("/result/groups/*/events"),
        spec("/result/groups/*/events"),
      ])
    ).toThrow(/overlap/)
  })
})

describe("number format", () => {
  it("matches the shared citation example", () => {
    expect(
      formatCitation({ id: "r_7f3a9c21.f4", value: 1204, unit: "log_events" })
    ).toBe(CITATION_EXAMPLE)
  })

  it("groups thousands and keeps decimals", () => {
    expect(formatFactValue(4_747_963)).toBe("4,747,963")
    expect(formatFactValue(999)).toBe("999")
    expect(formatFactValue(0.375)).toBe("0.375")
    expect(formatFactValue(-1234.5)).toBe("-1,234.5")
    expect(formatFactValue("2005-06-03T22:42:50.363779Z")).toBe(
      "2005-06-03T22:42:50.363779Z"
    )
  })
})
