/** Author: Codex golden_context (independent LOG-13 verifier). */
import { readFile } from "node:fs/promises"

import {
  aggregateContextOutputSchema,
  eventContextOutputSchema,
} from "@workspace/domain/tools/get-log-context"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import {
  createGoldenHarness,
  expectClose,
  type GoldenHarness,
} from "./helpers.ts"

const directionSchema = z.enum(["before", "after"])
const eventRow = z.object({
  direction: directionSchema,
  requested: z.number(),
  in_window: z.number(),
  event_id: z.number().nullable(),
  ts: z.string().nullable(),
  offset_ms: z.number().nullable(),
})
const aggregateRow = z.object({
  matched_events: z.number(),
  anchors: z.number(),
  excluded_patterns: z.number(),
  grid_from: z.string(),
  grid_to: z.string(),
  grid_windows: z.number(),
  direction: directionSchema,
  patterns_found: z.number(),
  pattern_id: z.string().nullable(),
  anchors_with_pattern: z.number().nullable(),
  example_event_id: z.number().nullable(),
  anchor_share: z.number().nullable(),
  base_rate_windows: z.number().nullable(),
  base_rate: z.number().nullable(),
  ratio: z.number().nullable(),
})

let harness: GoldenHarness
let eventSql: string
let aggregateSql: string
let benchmarkSql: string

beforeAll(async () => {
  harness = await createGoldenHarness()
  eventSql = await readFile(
    new URL("./get-log-context-event.sql", import.meta.url),
    "utf8"
  )
  benchmarkSql = await readFile(
    new URL("./get-log-context-benchmark.sql", import.meta.url),
    "utf8"
  )
  aggregateSql = await readFile(
    new URL("./get-log-context-aggregate.sql", import.meta.url),
    "utf8"
  )
})
afterAll(async () => {
  await harness?.close()
})

describe("get_log_context event · A-06 / LOG-19", () => {
  for (const fixture of [
    { event_id: 14738, scope: "same_node", before: 25, after: 25 },
    { event_id: 14738, scope: "same_component", before: 3, after: 25 },
    { event_id: 14738, scope: "dataset", before: 25, after: 2 },
    { event_id: 10000108, scope: "same_request", before: 25, after: 25 },
    { event_id: 10070746, scope: "same_request", before: 25, after: 25 },
    { event_id: 14738, scope: "dataset", before: 0, after: 0 },
    { event_id: 3399618, scope: "dataset", before: 25, after: 25 },
  ]) {
    it(`${fixture.scope}, event ${fixture.event_id}, limits ${fixture.before}/${fixture.after}`, async () => {
      const expected = await harness.sql(
        eventSql,
        [fixture.event_id, fixture.scope, 60, fixture.before, fixture.after],
        eventRow
      )
      const actual = await harness.run(
        "get_log_context",
        { mode: "event", ...fixture, window_minutes: 60 },
        eventContextOutputSchema
      )
      expect(actual.data.anchor.event_id).toBe(fixture.event_id)
      expect(actual.data.scope).toBe(fixture.scope)
      expect(
        fixture.event_id !== 3399618 ||
          expected.some(
            (row) => row.direction === "before" && row.offset_ms === 0
          )
      ).toBe(true)
      expect(
        fixture.event_id !== 10070746 ||
          expected.some((row) => row.event_id !== null)
      ).toBe(true)
      for (const direction of ["before", "after"] as const) {
        const rows = expected.filter((row) => row.direction === direction)
        const summary = rows[0]
        expect(summary).toBeDefined()
        if (summary === undefined)
          throw new Error("Missing Golden event direction")
        const selected = rows
          .filter((row) => row.event_id !== null)
          .map(({ event_id, ts, offset_ms }) => ({ event_id, ts, offset_ms }))
        const events =
          direction === "before"
            ? actual.data.events_before
            : actual.data.events_after
        expect(
          events.map(({ event_id, ts, offset_ms }) => ({
            event_id,
            ts,
            offset_ms,
          }))
        ).toEqual(selected)
        expect(
          actual.data.sides.find((side) => side.direction === direction)
        ).toEqual({
          direction,
          limit: summary.requested,
          in_window: summary.in_window,
          returned: selected.length,
          truncated: summary.in_window > selected.length,
        })
      }
    })
  }
})

const aggregateFixtures = [
  {
    name: "APPREAD full span, both directions, grid and top-n",
    dataset: "bgl",
    pattern_id: "287312f13c189c4d",
    direction: "both",
    window_minutes: 10,
    top_n: 5,
  },
  {
    name: "APPREAD before, clipped grid and fewer than five anchors",
    dataset: "bgl",
    pattern_id: "287312f13c189c4d",
    direction: "before",
    from: "2005-06-04T00:00:00Z",
    to: "2005-06-05T00:00:00Z",
    window_minutes: 60,
    top_n: 20,
  },
  {
    name: "APPREAD after, end-exclusive anchor scope",
    dataset: "bgl",
    pattern_id: "287312f13c189c4d",
    direction: "after",
    from: "2005-06-03T00:00:00Z",
    to: "2005-06-21T00:00:00Z",
    window_minutes: 1,
    top_n: 1,
  },
  {
    name: "OpenStack error search anchors independently matched by regex",
    dataset: "openstack",
    query: "error",
    regex: "\\berror\\b",
    direction: "both",
    window_minutes: 10,
    top_n: 20,
  },
  {
    name: "APPREAD node filter restricts anchors but not window events",
    dataset: "bgl",
    pattern_id: "287312f13c189c4d",
    node: "R23-M1-N8-I:J18-U11",
    direction: "both",
    window_minutes: 10,
    top_n: 20,
  },
  {
    name: "APPREAD scope starts/ends exactly on episode anchors",
    dataset: "bgl",
    pattern_id: "287312f13c189c4d",
    from: "2005-06-04T07:24:32.398284Z",
    to: "2005-06-09T03:21:20.145620Z",
    direction: "both",
    window_minutes: 10,
    top_n: 20,
  },
  {
    name: "unknown anchor pattern",
    dataset: "bgl",
    pattern_id: "0000000000000000",
    direction: "both",
    window_minutes: 10,
    top_n: 10,
  },
]

describe("get_log_context aggregate · R-05/R-11 / LOG-21", () => {
  for (const fixture of aggregateFixtures) {
    it(`${fixture.name}`, async () => {
      const { name: _name, regex, ...input } = { regex: undefined, ...fixture }
      const rowInput = {
        pattern_id: undefined,
        from: undefined,
        to: undefined,
        node: undefined,
        ...input,
      }
      const expected = await harness.sql(
        aggregateSql,
        [
          input.dataset,
          rowInput.pattern_id ?? null,
          regex ?? null,
          rowInput.from ?? null,
          rowInput.to ?? null,
          rowInput.node ?? null,
          input.window_minutes,
          input.top_n,
        ],
        aggregateRow
      )
      const actual = await harness.run(
        "get_log_context",
        { mode: "aggregate", ...input },
        aggregateContextOutputSchema
      )
      const first = expected[0]
      expect(first).toBeDefined()
      if (first === undefined)
        throw new Error("Missing Golden aggregate summary")
      expect(actual.data).toMatchObject({
        matched_events: first.matched_events,
        anchors: first.anchors,
        excluded_patterns: first.excluded_patterns,
        episode_gap_minutes: 30,
      })
      const grid = actual.data.base_rate_grid
      // ISO instants with/without an all-zero fractional part are identical.
      const actualGrid =
        grid === null
          ? null
          : {
              ...grid,
              from: grid.from.replace(/\.0+Z$/, "Z"),
              to: grid.to.replace(/\.0+Z$/, "Z"),
            }
      const expectedGrid =
        first.anchors < 5
          ? null
          : {
              from: first.grid_from.replace(/\.0+Z$/, "Z"),
              to: first.grid_to.replace(/\.0+Z$/, "Z"),
              windows: first.grid_windows,
              window_minutes: input.window_minutes,
            }
      expect(actualGrid).toEqual(expectedGrid)
      const directions =
        input.direction === "both" ? ["before", "after"] : [input.direction]
      expect(actual.data.by_direction.map((side) => side.direction)).toEqual(
        directions
      )
      for (const side of actual.data.by_direction) {
        const rows = expected.filter((row) => row.direction === side.direction)
        const summary = rows[0]
        if (summary === undefined)
          throw new Error("Missing Golden aggregate direction")
        const patterns = rows.filter((row) => row.pattern_id !== null)
        expect(side.patterns_found).toBe(summary.patterns_found)
        expect(side.truncated).toBe(summary.patterns_found > patterns.length)
        expect(
          side.patterns.map(
            ({
              pattern_id,
              anchors_with_pattern,
              base_rate_windows,
              example_event_id,
            }) => ({
              pattern_id,
              anchors_with_pattern,
              base_rate_windows,
              example_event_id,
            })
          )
        ).toEqual(
          patterns.map(
            ({
              pattern_id,
              anchors_with_pattern,
              base_rate_windows,
              example_event_id,
            }) => ({
              pattern_id,
              anchors_with_pattern,
              base_rate_windows,
              example_event_id,
            })
          )
        )
        for (const [index, pattern] of side.patterns.entries()) {
          const reference = patterns[index]
          if (reference === undefined)
            throw new Error("Missing Golden aggregate pattern")
          expectClose(pattern.anchor_share, reference.anchor_share)
          expectClose(pattern.base_rate, reference.base_rate)
          expectClose(pattern.ratio, reference.ratio)
        }
      }
    })
  }

  for (const anchor of [
    { query: "error" },
    { pattern_id: "8eb053329ba11348" },
  ]) {
    it(`T-12: full BGL ${JSON.stringify(anchor)}, both directions, 60 minutes`, async () => {
      const expected = await harness.sql(
        benchmarkSql,
        [
          anchor.pattern_id ?? null,
          anchor.query === undefined ? null : "\\berror\\b",
        ],
        aggregateRow.pick({
          matched_events: true,
          anchors: true,
          excluded_patterns: true,
        })
      )
      expect(expected).toHaveLength(1)
      const result = await harness.run(
        "get_log_context",
        {
          mode: "aggregate",
          dataset: "bgl",
          ...anchor,
          direction: "both",
          window_minutes: 60,
          top_n: 20,
        },
        aggregateContextOutputSchema
      )
      expect(result.data).toMatchObject(expected[0] ?? {})
      expect(result.data.anchors).toBeGreaterThanOrEqual(5)
      expect(result.data.by_direction.map((side) => side.direction)).toEqual([
        "before",
        "after",
      ])
    })
  }
})
