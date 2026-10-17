/**
 * get_log_context through the registry against SereneDB with the Loghub 2k
 * samples (`pnpm data:setup --samples`).
 *
 * Expected values were determined from the raw sample files, not from the
 * loader or the tool: a Python script read BGL_2k.log (event_id = line,
 * time = Unix seconds + microseconds of the text timestamp, node = fourth
 * field unless NULL) and OpenStack_2k.log (event_id = 10,000,000 + line,
 * time as UTC, component = file prefix, request ID from the request block),
 * then selected the neighbours in [anchor − w, anchor] and [anchor,
 * anchor + w] with ties placed by event_id and computed offsets from exact
 * microseconds. For mode aggregate it matched "generating" on the
 * lower-cased Loghub `Content` with the search tokenisation (see
 * search-logs.test.ts), formed episode starts with a 30-minute gap, grouped
 * window events by Loghub template (EventId) and counted base-rate windows
 * on a 10-minute grid from the first BGL event. Templates and patterns are
 * the same except where U03 splits a template (patterns.test.ts); the one
 * affected value is noted below.
 */
import { rm } from "node:fs/promises"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import { getLogContext } from "../../src/tools/get-log-context.ts"
import {
  loadEnv,
  runScript,
  samplesConnection,
  temporaryDir,
} from "./helpers.ts"

loadEnv()

let db: Database
let dir: string
let registry: Registry

beforeAll(async () => {
  db = createDatabase(samplesConnection())
  dir = await temporaryDir("analytics-context-")
  registry = createRegistry({
    db,
    receipts: new FileReceiptStore(dir),
    log: () => undefined,
  })
})

afterAll(async () => {
  await db.dispose()
  await rm(dir, { recursive: true, force: true })
})

const call = () => ({
  client: "test" as const,
  signal: new AbortController().signal,
})

async function run(input: Record<string, unknown>) {
  return registry.runTool("get_log_context", input, call())
}

async function context(input: Record<string, unknown>) {
  const outcome = await run(input)
  if (!outcome.ok) throw new Error(outcome.error.message)
  return {
    ...outcome.result,
    data: getLogContext.output.parse(outcome.result.data),
  }
}

async function eventContext(input: Record<string, unknown>) {
  const result = await context({ mode: "event", ...input })
  if (result.data.mode !== "event") throw new Error("not mode event")
  return { ...result, data: result.data }
}

const offsets = (list: readonly { event_id: number; offset_ms: number }[]) =>
  list.map((event) => [event.event_id, event.offset_ms])

/** BGL line 331 on R02-M1-N0-C:J12-U11, 2005-06-15T16:25:06.962646Z. */
const BEFORE_331 = [
  [326, -466_453.127],
  [327, -162_716.497],
  [328, -81_258.665],
  [329, -46_715.995],
  [330, -3380.275],
]

describe("mode event on BGL", () => {
  it("lists the neighbours on the same node with exact offsets", async () => {
    const { data, facts } = await eventContext({
      event_id: 331,
      scope: "same_node",
    })
    expect(data.anchor).toMatchObject({
      event_id: 331,
      dataset: "bgl",
      ts: "2005-06-15T16:25:06.962646Z",
      node: "R02-M1-N0-C:J12-U11",
      component: "KERNEL",
    })
    expect(offsets(data.events_before)).toEqual(BEFORE_331)
    // Line 333 (R34-M1-N9-C:J07-U11) is on another node.
    expect(offsets(data.events_after)).toEqual([[332, 206_668.496]])
    const offset = facts.find(
      (fact) => fact.path === "/result/events_before/4/offset_ms"
    )
    expect(offset).toMatchObject({
      value: -3380.275,
      metric: "offset",
      unit: "ms",
      group: { event_id: "330" },
    })
  })

  it("includes other nodes with scope dataset", async () => {
    const { data } = await eventContext({ event_id: 331, scope: "dataset" })
    expect(offsets(data.events_before)).toEqual(BEFORE_331)
    expect(offsets(data.events_after)).toEqual([
      [332, 206_668.496],
      [333, 369_660.572],
    ])
  })

  it("defaults to same_node", async () => {
    // Line 127 on R30-M0-N9-C:J16-U01, 2005-06-12T02:32:27.820915Z.
    const { data } = await eventContext({ event_id: 127 })
    expect(data.scope).toBe("same_node")
    expect(offsets(data.events_before)).toEqual([
      [123, -504_634.368],
      [124, -461_829.881],
      [125, -127_235.585],
      [126, -37_028.403],
    ])
    expect(offsets(data.events_after)).toEqual([
      [128, 35_972.511],
      [129, 408_052.176],
      [130, 524_985.584],
    ])
  })

  it("truncates per side and keeps the exact count in the window", async () => {
    // Line 1899, 2005-12-01T16:39:00.094017Z: 35 events before, 28 after.
    const { data, receipt } = await eventContext({
      event_id: 1899,
      scope: "dataset",
    })
    expect(
      data.sides.map((side) => [side.in_window, side.returned, side.truncated])
    ).toEqual([
      [35, 10, true],
      [28, 10, true],
    ])
    expect(data.events_before.map((event) => event.event_id)).toEqual(
      Array.from({ length: 10 }, (_, i) => 1889 + i)
    )
    expect(data.events_after.map((event) => event.event_id)).toEqual(
      Array.from({ length: 10 }, (_, i) => 1900 + i)
    )
    expect(offsets(data.events_before).at(0)).toEqual([1889, -162_359.728])
    expect(offsets(data.events_after).at(-1)).toEqual([1909, 182_665.862])
    expect(receipt.truncated).toBe(true)
  })

  it("rejects same_request on BGL and an unknown event_id", async () => {
    const request = await run({
      mode: "event",
      event_id: 331,
      scope: "same_request",
    })
    expect(request.ok ? null : request.error).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "scope" }],
    })
    const unknown = await run({ mode: "event", event_id: 999_999 })
    expect(unknown.ok ? null : unknown.error).toMatchObject({
      code: "not_found",
      resource: "event",
      id: "999999",
      hint: "Use an event_id returned by search_logs or another tool.",
    })
  })
})

describe("mode event on OpenStack", () => {
  it("lists every line of the same request in the window, ties by event_id", async () => {
    // Line 67 (req-6a763803-…, 00:00:31.094); line 68 has the same timestamp.
    const { data, receipt } = await eventContext({
      event_id: 10_000_067,
      scope: "same_request",
    })
    expect(data.scope_value).toBe("req-6a763803-4838-49c7-814e-eaefbaddee9d")
    expect(offsets(data.events_before)).toEqual([
      [10_000_062, -306],
      [10_000_064, -2],
      [10_000_065, -1],
      [10_000_066, -1],
    ])
    expect(offsets(data.events_after)).toEqual([
      [10_000_068, 0],
      [10_000_069, 1],
      [10_000_070, 1],
      [10_000_071, 33],
      [10_000_074, 605],
      [10_000_115, 20_565],
      [10_000_118, 20_700],
    ])
    const stored = await new FileReceiptStore(dir).get(receipt.receipt_id)
    if (stored === null) throw new Error("receipt missing")
    // Anchor, counts per side, nearest before (descending), nearest after.
    expect(stored.sql).toHaveLength(4)
    expect(stored.sql[0]).toContain("WHERE log_events.event_id = $1")
    expect(stored.sql[1]).toContain("count(*) FILTER")
    expect(stored.sql[2]).toContain(
      "ORDER BY log_events.ts DESC, log_events.event_id DESC LIMIT $"
    )
    expect(stored.sql[3]).toContain(
      "ORDER BY log_events.ts, log_events.event_id LIMIT $"
    )
  })

  it("lists at most 25 per side in the same component", async () => {
    // Line 631 (nova-api, 00:04:48.611): 324 nova-api lines before, 735 after.
    const { data } = await eventContext({
      event_id: 10_000_631,
      before: 25,
      after: 25,
    })
    expect(data.scope).toBe("same_component")
    expect(
      data.sides.map((side) => [side.in_window, side.returned, side.truncated])
    ).toEqual([
      [324, 25, true],
      [735, 25, true],
    ])
    expect(offsets(data.events_before).at(0)).toEqual([10_000_581, -23_559])
    expect(offsets(data.events_before).at(-1)).toEqual([10_000_630, -1283])
    expect(offsets(data.events_after).at(0)).toEqual([10_000_632, 270])
    expect(offsets(data.events_after).at(-1)).toEqual([10_000_678, 18_287])
  })

  it("rejects same_node for OpenStack", async () => {
    const outcome = await run({
      mode: "event",
      event_id: 10_000_067,
      scope: "same_node",
    })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      issues: [
        {
          path: "scope",
          message: "Event 10000067 has no node (OpenStack events have none).",
        },
      ],
    })
  })
})

describe("mode event reproducibility", () => {
  it("returns the same digest on a second run and on rerun", async () => {
    const input = { event_id: 1899, scope: "dataset", before: 25, after: 25 }
    const first = await eventContext(input)
    const second = await eventContext(input)
    expect(second.receipt.result_digest).toBe(first.receipt.result_digest)
    const rerun = await registry.rerun(first.receipt.receipt_id, call())
    expect(rerun.ok ? rerun.matches : rerun.error).toEqual({
      signature: true,
      data_version: true,
      result_digest: true,
    })
  })

  it("keeps times, offsets and digest under three process time zones", async () => {
    const outputs = await Promise.all(
      ["UTC", "America/Los_Angeles", "Asia/Kolkata"].map((zone) =>
        runScript("print-context.ts", [dir, "331"], zone)
      )
    )
    const [utc, ...others] = outputs.map((line) => JSON.parse(line) as unknown)
    expect(utc).toMatchObject({
      data: {
        anchor: { ts: "2005-06-15T16:25:06.962646Z" },
        events_before: [
          { event_id: 326, ts: "2005-06-15T16:17:20.509519Z" },
          {},
          {},
          {},
          {},
        ],
      },
    })
    for (const other of others) expect(other).toEqual(utc)
  })
})

async function generating(direction: "before" | "after") {
  const result = await context({
    mode: "aggregate",
    dataset: "bgl",
    query: "generating",
    direction,
  })
  if (result.data.mode !== "aggregate") throw new Error("not aggregate")
  return { ...result, data: result.data }
}

describe("mode aggregate on BGL", () => {
  it("forms anchors from episode starts and computes the base rate in SereneDB", async () => {
    // "generating core.<n>": 721 lines, 80 episode starts (gap ≥ 30 min).
    const { data } = await generating("before")
    expect(data).toMatchObject({
      matched_events: 721,
      anchors: 80,
      excluded_patterns: 1,
      base_rate_grid: {
        from: "2005-06-03T22:42:50.675872Z",
        to: "2006-01-03T15:13:09.127919Z",
        window_minutes: 10,
        windows: 30_772,
      },
    })
    const [before] = data.by_direction
    expect(before?.patterns_found).toBe(3)
    // Keyed by example event: E3 (line 752), E77 (327), E4 (1106); one
    // anchor each, base-rate windows 37, 28 and 40 of 30,772.
    const byExample = new Map(
      before?.patterns.map((row) => [row.example_event_id, row])
    )
    for (const [example, windows] of [
      [752, 37],
      [327, 28],
      [1106, 40],
    ] as const) {
      expect(byExample.get(example)).toMatchObject({
        anchors_with_pattern: 1,
        anchor_share: 1 / 80,
        base_rate_windows: windows,
        base_rate: windows / 30_772,
      })
      expect(byExample.get(example)?.ratio).toBeCloseTo(
        1 / 80 / (windows / 30_772),
        9
      )
    }
    // Equal anchor counts are ordered by pattern_id.
    const order = before?.patterns.map((row) => row.pattern_id) ?? []
    expect(order).toEqual(order.toSorted())
  })

  it("looks after the anchors with (anchor, anchor + 10 min]", async () => {
    const { data } = await generating("after")
    const [after] = data.by_direction
    expect(after?.patterns_found).toBe(8)
    // E98 (line 433), E103 (437) and E101 (435) follow two anchors each, the
    // other five templates one.
    expect(
      after?.patterns.map((row) => [
        row.example_event_id,
        row.anchors_with_pattern,
      ])
    ).toEqual(
      expect.arrayContaining([
        [433, 2],
        [437, 2],
        [435, 2],
        [450, 1],
        [454, 1],
        [451, 1],
        [69, 1],
        [1117, 1],
      ])
    )
    const windows = new Map(
      after?.patterns.map((row) => [
        row.example_event_id,
        row.base_rate_windows,
      ])
    )
    // E98 and E103 in 2 and 4 grid windows. E101 is not compared: U03 splits
    // it by its 0/1 status bit, so its pattern covers fewer lines than the
    // template.
    expect(windows.get(433)).toBe(2)
    expect(windows.get(437)).toBe(4)
  })

  it("requires exactly one dataset", async () => {
    const outcome = await run({ mode: "aggregate", query: "generating" })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      issues: [
        {
          path: "dataset",
          message: "Precursor analysis runs within one dataset.",
        },
      ],
    })
  })

  it("rejects a query without searchable words", async () => {
    const outcome = await run({
      mode: "aggregate",
      dataset: "bgl",
      query: "!!!",
    })
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "query" }],
    })
  })
})
