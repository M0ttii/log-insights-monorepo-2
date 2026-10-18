import { describe, expect, it } from "vitest"

import {
  createOtelMeasurementRunner,
  parseOtelProfile,
  parseOtelMeasureArgs,
} from "./otel-measure.ts"
import { QueryFailure } from "./db.ts"

describe("local otel measurement evidence", () => {
  it("keeps display-rounded HTTP bytes and sums independent Parquet branches", () => {
    const profile = parseOtelProfile([
      { "QUERY PLAN": "││ HTTPFS HTTP Stats ││" },
      { "QUERY PLAN": "││ in: 16.8 MiB ││" },
      { "QUERY PLAN": "││ #HEAD: 2 ││" },
      { "QUERY PLAN": "││ #GET: 15 ││" },
      { "QUERY PLAN": "│ Total Time: 1.84s │" },
      { "QUERY PLAN": "│ Row Groups Scanned: 4 / 1624 │" },
      { "QUERY PLAN": "│ Row Groups Scanned: 7 / 1625 │" },
    ])
    expect(profile).toEqual({
      server_seconds: 1.84,
      httpfs: {
        bytes_in_display: "16.8 MiB",
        bytes_in_exact: null,
        get: 15,
        head: 2,
      },
      parquet_row_groups: { scanned: 11, total: 3249 },
      plan: expect.any(String),
    })
  })

  it("distinguishes an absent HTTP box and index row groups from zero remote reads", () => {
    const profile = parseOtelProfile([
      { "QUERY PLAN": "│ Total Time: 0.0058s │" },
    ])
    expect(profile.httpfs).toBeNull()
    expect(profile.parquet_row_groups).toBeNull()
    expect(
      parseOtelProfile([
        { "QUERY PLAN": "HTTPFS HTTP Stats\nin: 0 bytes\n#HEAD: 1\n#GET: 0" },
      ]).httpfs
    ).toEqual({
      bytes_in_display: "0 bytes",
      bytes_in_exact: 0,
      get: 0,
      head: 1,
    })
  })

  it("rejects unsafe container identifiers and unknown cases before connecting", () => {
    expect(() => parseOtelMeasureArgs(["--container", "bad/name"])).toThrow(
      /Invalid string/
    )
    expect(() => parseOtelMeasureArgs(["--case", "all-data"])).toThrow(
      /Invalid option/
    )
    expect(
      parseOtelMeasureArgs([
        "--case",
        "part024-first-touch",
        "--container",
        "log-insights-log35-serenedb-1",
      ]).case
    ).toBe("part024-first-touch")
  })
  it("persists timeout evidence and never follows a failed profile with a result query", async () => {
    const calls: string[] = []
    const evidence: Record<string, unknown>[] = []
    const timeout = new QueryFailure("timeout", "57014")
    const measured = createOtelMeasurementRunner(
      {
        async query(sql) {
          calls.push(sql)
          throw timeout
        },
      },
      async (record) => {
        evidence.push(record)
      },
      () => null,
      true
    )
    await expect(
      measured.query(
        "SELECT count(*) FROM otel_ref_idx",
        [],
        new AbortController().signal
      )
    ).rejects.toBe(timeout)
    expect(calls).toEqual(["EXPLAIN ANALYZE SELECT count(*) FROM otel_ref_idx"])
    expect(evidence.map((record) => record.type)).toEqual([
      "statement_start",
      "statement_failure",
    ])
    expect(evidence[1]?.error).toEqual({ kind: "timeout", sqlstate: "57014" })
  })
})
