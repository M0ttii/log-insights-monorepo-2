import { describe, expect, it } from "vitest"

import { profilingQueries } from "./profiling-queries.ts"

describe("profilingQueries", () => {
  it("splits a file into titled single-statement queries", () => {
    const text = [
      "-- Levels per dataset.",
      "",
      "-- @ BGL levels",
      "-- Counted over log_events.",
      "SELECT level, count(*) FROM log_events GROUP BY level;",
      "-- @ OpenStack levels",
      "SELECT 1",
    ].join("\n")
    expect(profilingQueries(text)).toEqual([
      {
        title: "BGL levels",
        sql: "SELECT level, count(*) FROM log_events GROUP BY level",
      },
      { title: "OpenStack levels", sql: "SELECT 1" },
    ])
  })

  it("rejects a statement before the first title", () => {
    expect(() => profilingQueries("SELECT 1;\n-- @ a\nSELECT 2")).toThrow(
      /before the first/
    )
  })

  it("rejects a query with two statements or none", () => {
    expect(() => profilingQueries("-- @ a\nSELECT 1; SELECT 2")).toThrow(
      /exactly one/
    )
    expect(() => profilingQueries("-- @ a\n-- only a comment")).toThrow(
      /exactly one/
    )
  })
})
