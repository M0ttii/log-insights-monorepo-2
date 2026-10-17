/**
 * latency_stats through the registry against SereneDB with the Loghub 2k
 * samples (`pnpm data:setup --samples`) and the synthetic API fixtures
 * (latency-fixtures.ts).
 *
 * Expected values were determined from the raw sample file, not from the
 * loader or the tool: a Python script matched the API access suffix
 * `"<method> <path> HTTP/1.1" status: <code> len: <n> time: <s>` of every
 * line of OpenStack_2k.log, took the request ID from `[req-…` (none for
 * `[-]`), the latency as Decimal(time) · 1000 and masked the path like
 * domain/endpoint.ts, then counted with collections.Counter. Percentiles
 * use the definition of quantile_cont (and numpy's default "linear"): for
 * n sorted values and p, h = (n − 1) · p, value = v[⌊h⌋] + (h − ⌊h⌋) ·
 * (v[⌊h⌋ + 1] − v[⌊h⌋]). The fixture values are worked out by hand in the
 * comments below.
 */
import { rm } from "node:fs/promises"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase, type Database } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, type Registry } from "../../src/registry.ts"
import { latencyStats } from "../../src/tools/latency-stats.ts"
import { loadEnv, samplesConnection, temporaryDir } from "./helpers.ts"
import {
  buildLatencyFixtures,
  LATENCY_FIXTURE,
  latencyFixtureConnection,
} from "./latency-fixtures.ts"

loadEnv()

const OPENSTACK_FIRST = "2017-05-16T00:00:00.008000Z"
const OPENSTACK_END = "2017-05-16T00:14:47.687001Z"

let db: Database
let fixturesDb: Database
let dir: string
let registry: Registry
let fixtures: Registry

beforeAll(async () => {
  await buildLatencyFixtures()
  db = createDatabase(samplesConnection())
  fixturesDb = createDatabase(latencyFixtureConnection())
  dir = await temporaryDir("analytics-latency-")
  const receipts = new FileReceiptStore(dir)
  registry = createRegistry({ db, receipts, log: () => undefined })
  fixtures = createRegistry({ db: fixturesDb, receipts, log: () => undefined })
})

afterAll(async () => {
  await db.dispose()
  await fixturesDb.dispose()
  await rm(dir, { recursive: true, force: true })
})

const call = () => ({
  client: "test" as const,
  signal: new AbortController().signal,
})

async function latency(input: Record<string, unknown>, on = registry) {
  const outcome = await on.runTool("latency_stats", input, call())
  if (!outcome.ok) throw new Error(outcome.error.message)
  return {
    ...outcome.result,
    data: latencyStats.output.parse(outcome.result.data),
  }
}

async function error(input: Record<string, unknown>) {
  const outcome = await registry.runTool("latency_stats", input, call())
  return outcome.ok ? null : outcome.error
}

const NO_5XX = (denominator: string) =>
  `no 5xx API access events in scope (observed zero, denominator ${denominator})`

describe("samples: counting units (R-01)", () => {
  it("counts every API access, those without request ID and unique requests in the total row", async () => {
    const result = await latency({})
    expect(result.data.total).toMatchObject({
      api_access_events: 1017,
      without_request_id: 89,
      unique_requests: 928,
      latency_values: 1017,
      errors_5xx: 0,
      rate_5xx: 0,
      errors_4xx: 41,
    })
    expect(result.data.total.rate_4xx).toBeCloseTo(41 / 1017, 12)
    expect(result.data).toMatchObject({
      dataset: "openstack",
      unit: "api_accesses",
      group_by: null,
      groups: [],
      other: null,
      group_count: 0,
      top_n: null,
      truncated: false,
      data_span: {
        first: OPENSTACK_FIRST,
        last: "2017-05-16T00:14:47.687000Z",
      },
    })
    expect(result.receipt.population).toEqual({
      count: 1017,
      unit: "api_accesses",
    })
    expect(result.receipt.scope).toEqual({
      windows: [
        { dataset: "openstack", from: OPENSTACK_FIRST, to: OPENSTACK_END },
      ],
      filters: {},
    })
  })

  it("names the counting units and the client-error status in every result", async () => {
    const { notes } = await latency({})
    expect(notes).toContain(
      "Rates are per API access event (OpenStack lines with an HTTP status, with or without request ID); unique requests are counted separately (R-01). rate_5xx = errors_5xx / api_access_events, rate_4xx = errors_4xx / api_access_events."
    )
    expect(notes).toContain(
      "5xx (500–599) are failed API accesses; 4xx (400–499) are client errors, not failed accesses (R-02). Counts are API accesses, not incidents or outages."
    )
  })

  it("reports the missing 5xx as an observed zero with its denominator (O-06)", async () => {
    const result = await latency({})
    expect(result.notes).toContain(NO_5XX("1,017"))
    const rate = result.facts.find((f) => f.path === "/result/total/rate_5xx")
    expect(rate).toMatchObject({
      value: 0,
      metric: "rate_5xx",
      unit: "ratio",
      group: {},
    })
  })

  it("separates 4xx and 5xx by status; 404 holds the 12 accesses without request ID", async () => {
    const { data } = await latency({ group_by: "status" })
    expect(
      data.groups.map((g) => [
        g.status,
        g.api_access_events,
        g.without_request_id,
        g.unique_requests,
        g.errors_4xx,
        g.errors_5xx,
      ])
    ).toEqual([
      [200, 933, 77, 856, 0, 0],
      [404, 41, 12, 29, 41, 0],
      [204, 22, 0, 22, 0, 0],
      [202, 21, 0, 21, 0, 0],
    ])
    expect(data.groups[1]?.rate_4xx).toBe(1)
    expect(data.group_count).toBe(4)
    expect(data.other).toBeNull()
  })

  it("groups by method with the API access counts of the raw file", async () => {
    const { data } = await latency({ group_by: "method" })
    expect(data.groups.map((g) => [g.method, g.api_access_events])).toEqual([
      ["GET", 931],
      ["POST", 64],
      ["DELETE", 22],
    ])
  })
})

describe("samples: percentiles", () => {
  it("matches hand-computed continuous percentiles of a small endpoint", async () => {
    // /latest/meta-data/local-ipv4: 0.669, 0.8481, 0.8519 ms (n = 3).
    // p50: h = 1 → 0.8481. p90: h = 1.8 → 0.8481 + 0.8 · 0.0038 = 0.85114.
    // p95: h = 1.9 → 0.85152. p99: h = 1.98 → 0.851824. max 0.8519.
    const { data } = await latency({
      endpoints: ["/latest/meta-data/local-ipv4"],
    })
    const { total } = data
    expect(total.api_access_events).toBe(3)
    expect(total.p50_ms).toBeCloseTo(0.8481, 9)
    expect(total.p90_ms).toBeCloseTo(0.85114, 9)
    expect(total.p95_ms).toBeCloseTo(0.85152, 9)
    expect(total.p99_ms).toBeCloseTo(0.851824, 9)
    expect(total.max_ms).toBe(0.8519)
  })

  it("matches the percentiles of all accesses from the raw file", async () => {
    const { total } = (await latency({})).data
    expect(total.p50_ms).toBeCloseTo(259.165, 9)
    expect(total.p90_ms).toBeCloseTo(286.31966, 9)
    expect(total.p95_ms).toBeCloseTo(384.3792, 9)
    expect(total.p99_ms).toBeCloseTo(504.143204, 9)
    expect(total.max_ms).toBe(711.6742)
  })

  it("ranks endpoints by accesses and aggregates the rest in other over its accesses", async () => {
    const { data, notes } = await latency({ group_by: "endpoint", top_n: 3 })
    expect(
      data.groups.map((g) => [g.endpoint, g.api_access_events, g.errors_4xx])
    ).toEqual([
      ["/v2/<ID>/servers/detail", 700, 0],
      ["/openstack/2013-10-17/vendor_data.json", 44, 0],
      ["/v2/<ID>/os-server-external-events", 43, 21],
    ])
    expect(data.groups[0]?.p50_ms).toBeCloseTo(264.55595, 9)
    // 25 endpoints, 1017 − 700 − 44 − 43 = 230 accesses beyond the top 3.
    expect(data.group_count).toBe(25)
    expect(data.other).toMatchObject({
      groups: 22,
      api_access_events: 230,
      errors_4xx: 20,
    })
    expect(data.truncated).toBe(true)
    expect(notes.some((note) => note.startsWith("Truncated: 3 of 25"))).toBe(
      true
    )
  })
})

describe("samples: input rules", () => {
  it("rejects BGL, unknown groupings and top_n with time buckets", async () => {
    expect(await error({ dataset: "bgl" })).toMatchObject({
      code: "invalid_input",
      issues: [
        {
          path: "dataset",
          message: expect.stringContaining("OpenStack API accesses only"),
        },
      ],
    })
    expect(await error({ group_by: "node" })).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "group_by" }],
    })
    expect(await error({ group_by: "hour", top_n: 5 })).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "top_n" }],
    })
    expect(await error({ top_n: 5 })).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "top_n" }],
    })
    expect(await error({ node: "R02" })).toMatchObject({
      code: "invalid_input",
    })
    expect(await error({ http_status: { min: 599, max: 500 } })).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "http_status" }],
    })
  })

  it("returns the same digest for the same input and on re-run", async () => {
    const first = await latency({ group_by: "endpoint", top_n: 5 })
    const second = await latency({ group_by: "endpoint", top_n: 5 })
    expect(second.receipt.result_digest).toBe(first.receipt.result_digest)
    expect(second.receipt.signature).toBe(first.receipt.signature)
    const rerun = await registry.rerun(first.receipt.receipt_id, call())
    if (!rerun.ok) throw new Error(rerun.error.message)
    expect(rerun.matches).toEqual({
      signature: true,
      data_version: true,
      result_digest: true,
    })
  })
})

describe("fixtures", () => {
  it("computes counts, percentiles and both rates of the whole scope", async () => {
    // 9 accesses (the 11:15 line has no status); without request ID 10:06,
    // 10:07; requests req-1 … req-6 (req-1 twice) = 6; 8 latencies, sorted
    // 50, 70, 100, 200, 250, 300, 400, 1000, h = 7p:
    // p50 h = 3.5 → 225; p90 h = 6.3 → 400 + 0.3 · 600 = 580;
    // p95 h = 6.65 → 790; p99 h = 6.93 → 958.
    const { data, notes } = await latency({}, fixtures)
    const { total } = data
    expect(total).toMatchObject({
      api_access_events: 9,
      without_request_id: 2,
      unique_requests: 6,
      latency_values: 8,
      max_ms: 1000,
      errors_5xx: 1,
      errors_4xx: 2,
    })
    expect(total.p50_ms).toBeCloseTo(225, 9)
    expect(total.p90_ms).toBeCloseTo(580, 9)
    expect(total.p95_ms).toBeCloseTo(790, 9)
    expect(total.p99_ms).toBeCloseTo(958, 9)
    expect(total.rate_5xx).toBeCloseTo(1 / 9, 12)
    expect(total.rate_4xx).toBeCloseTo(2 / 9, 12)
    expect(notes).toContain(
      "1 API accesses have no latency; they are counted but not in the percentiles."
    )
    expect(notes.some((note) => note.startsWith("no 5xx"))).toBe(false)
  })

  it("keeps 4xx and 5xx apart per status", async () => {
    // 200: 6 accesses, 10:07 without request ID, requests req-1 … req-4;
    // latencies 100, 200, 250, 300, 400 → p50 250, p90 h = 3.6 → 360.
    const { data } = await latency({ group_by: "status" }, fixtures)
    expect(
      data.groups.map((g) => [
        g.status,
        g.api_access_events,
        g.without_request_id,
        g.unique_requests,
        g.errors_4xx,
        g.rate_4xx,
        g.errors_5xx,
        g.rate_5xx,
      ])
    ).toEqual([
      [200, 6, 1, 4, 0, 0, 0, 0],
      [404, 2, 1, 1, 2, 1, 0, 0],
      [503, 1, 0, 1, 0, 0, 1, 1],
    ])
    expect(data.groups[0]?.p50_ms).toBeCloseTo(250, 9)
    expect(data.groups[0]?.p90_ms).toBeCloseTo(360, 9)
    expect(data.groups[1]?.p50_ms).toBeCloseTo(60, 9)
  })

  it("computes other over its own accesses, not from the listed groups", async () => {
    // servers/detail 6 (latencies 100, 200, 250, 300, 400, 1000 → p50 275,
    // 1 × 503, requests req-1 … req-5), other = events (2) + meta-data (1):
    // 3 accesses, 2 without request ID, 1 request (req-6), latencies 50, 70.
    const { data } = await latency({ group_by: "endpoint", top_n: 1 }, fixtures)
    expect(data.groups).toHaveLength(1)
    expect(data.groups[0]).toMatchObject({
      endpoint: LATENCY_FIXTURE.SERVERS,
      api_access_events: 6,
      unique_requests: 5,
      errors_5xx: 1,
    })
    expect(data.groups[0]?.p50_ms).toBeCloseTo(275, 9)
    expect(data.groups[0]?.rate_5xx).toBeCloseTo(1 / 6, 12)
    expect(data.other).toMatchObject({
      groups: 2,
      api_access_events: 3,
      without_request_id: 2,
      unique_requests: 1,
      latency_values: 2,
      max_ms: 70,
      errors_4xx: 2,
      errors_5xx: 0,
      rate_5xx: 0,
    })
    expect(data.other?.p50_ms).toBeCloseTo(60, 9)
    expect(data.other?.rate_4xx).toBeCloseTo(2 / 3, 12)
  })

  it("orders equal counts by key", async () => {
    const { data } = await latency(
      { group_by: "method", endpoints: [LATENCY_FIXTURE.EVENTS] },
      fixtures
    )
    expect(data.groups.map((g) => [g.method, g.api_access_events])).toEqual([
      ["GET", 1],
      ["POST", 1],
    ])
  })

  it("lists every hour of the span: empty hours as no data, capture gaps marked", async () => {
    // Span 10:00:00 – 13:30:00 (the 11:15 line counts for the span and
    // the capture coverage, not as an access); 12:00 has no event at all.
    const { data, notes } = await latency({ group_by: "hour" }, fixtures)
    expect(
      data.groups.map((g) => [
        g.bucket_start,
        g.api_access_events,
        g.partial,
        g.capture_gap,
      ])
    ).toEqual([
      ["2017-05-14T10:00:00.000000Z", 8, false, false],
      ["2017-05-14T11:00:00.000000Z", 0, false, false],
      ["2017-05-14T12:00:00.000000Z", 0, false, true],
      ["2017-05-14T13:00:00.000000Z", 1, true, false],
    ])
    expect(data.groups[1]).toMatchObject({
      p50_ms: null,
      max_ms: null,
      rate_5xx: null,
      rate_4xx: null,
    })
    expect(data.groups[0]?.bucket_end).toBe("2017-05-14T11:00:00.000000Z")
    expect(data.group_count).toBe(4)
    expect(notes).toContain(
      "1 bucket(s) marked capture_gap contain no OpenStack event at all: the logs captured nothing there, so their zero is no observed calm."
    )
  })

  it("states an observed zero with denominator for a scope without 5xx (§ 13)", async () => {
    const result = await latency({ from: "2017-05-14T13:00:00Z" }, fixtures)
    expect(result.data.total).toMatchObject({
      api_access_events: 1,
      errors_5xx: 0,
      rate_5xx: 0,
    })
    expect(result.notes).toContain(NO_5XX("1"))
    const facts = result.facts.filter((f) =>
      ["errors_5xx", "rate_5xx", "api_access_events"].includes(f.metric)
    )
    expect(facts.map((f) => [f.metric, f.value, f.unit])).toEqual([
      ["api_access_events", 1, "api_accesses"],
      ["errors_5xx", 0, "api_accesses"],
      ["rate_5xx", 0, "ratio"],
    ])
  })

  it("rates over the filtered accesses with an http_status range, and says so", async () => {
    const { data, notes } = await latency(
      { http_status: { min: 500, max: 599 } },
      fixtures
    )
    expect(data.total).toMatchObject({
      api_access_events: 1,
      errors_5xx: 1,
      rate_5xx: 1,
    })
    expect(notes).toContain(
      "Only API accesses with status 500–599 are in scope, so every rate is a share of these filtered accesses, not of all accesses."
    )
  })

  it("returns an empty result with a note when the scope has no API access", async () => {
    // req-7 is the 11:15 line, which is no API access.
    const result = await latency(
      { request_id: "req-7", group_by: "status" },
      fixtures
    )
    expect(result.data.total).toMatchObject({
      api_access_events: 0,
      unique_requests: 0,
      p50_ms: null,
      rate_5xx: null,
      rate_4xx: null,
    })
    expect(result.data.groups).toEqual([])
    expect(result.notes).toContain(
      'No API access events in scope: openstack [2017-05-14T10:00:00.000000Z, 2017-05-14T13:30:00.000001Z) with request_id="req-7". Counts are 0; percentiles and rates are null because there is no denominator.'
    )
    // A null value produces no fact: a missing rate is not zero.
    expect(result.facts.some((f) => f.path === "/result/total/rate_5xx")).toBe(
      false
    )
  })

  it("marks a window outside the data span as no data, not zero (R-03)", async () => {
    const result = await latency(
      {
        from: "2017-06-01T00:00:00Z",
        to: "2017-06-02T00:00:00Z",
        group_by: "day",
      },
      fixtures
    )
    expect(result.data.effective_range).toBeNull()
    expect(result.data.groups).toEqual([])
    expect(result.notes).toContain(
      "The window lies outside the OpenStack data span (2017-05-14T10:00:00.000000Z to 2017-05-14T13:30:00.000000Z): its count of 0 is not an observed zero (R-03)."
    )
  })

  it("gives every number of a group a fact with the group key", async () => {
    const { facts } = await latency({ group_by: "status" }, fixtures)
    const of404 = facts.filter((f) => f.group.status === "404")
    expect(of404.map((f) => [f.metric, f.unit])).toEqual(
      expect.arrayContaining([
        ["api_access_events", "api_accesses"],
        ["unique_requests", "requests"],
        ["p95_ms", "ms"],
        ["errors_4xx", "api_accesses"],
        ["rate_4xx", "ratio"],
      ])
    )
    expect(of404).toHaveLength(13)
  })
})
