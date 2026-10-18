import { describe, expect, it } from "vitest"
import { z } from "zod"

import { filterSchema, pickFilter, validateFilter } from "./filters.ts"

const window = { from: "2005-06-03T00:00:00Z", to: "2005-06-04T00:00:00Z" }

function issuePaths(filter: Parameters<typeof validateFilter>[0]): string[] {
  const error = validateFilter(filter)
  if (error === null) return []
  if (error.code !== "invalid_input")
    throw new Error(`unexpected ${error.code}`)
  return error.issues.map((issue) => issue.path)
}

describe("filterSchema", () => {
  it("accepts a full BGL filter", () => {
    const filter = {
      dataset: "bgl",
      ...window,
      components: ["KERNEL"],
      levels: ["FATAL", "FAILURE"],
      node: "R02-M1-N0-C:J12-U11",
      rack: "R02",
      only_errors: true,
      text: "machine check interrupt",
    }
    expect(filterSchema.parse(filter)).toEqual(filter)
  })

  it("requires a zone on times", () => {
    expect(
      filterSchema.safeParse({ from: "2005-06-03T00:00:00" }).success
    ).toBe(false)
    expect(
      filterSchema.safeParse({ from: "2005-06-03T02:00:00+02:00" }).success
    ).toBe(true)
  })

  it("rejects unknown fields instead of ignoring them", () => {
    expect(
      filterSchema.safeParse({ dataset: "bgl", unknown_field: "x" }).success
    ).toBe(false)
  })

  it("bounds lists and text", () => {
    expect(
      filterSchema.safeParse({
        components: Array.from({ length: 21 }, (_, i) => `C${i}`),
      }).success
    ).toBe(false)
    expect(filterSchema.safeParse({ components: [] }).success).toBe(false)
    expect(filterSchema.safeParse({ text: "x".repeat(201) }).success).toBe(
      false
    )
    expect(filterSchema.safeParse({ text: "x".repeat(200) }).success).toBe(true)
    // Levels are matched exactly as logged, so Apache's lower-case levels parse.
    expect(filterSchema.safeParse({ levels: ["error"] }).success).toBe(true)
    // An extension dataset is a valid dataset value (U26).
    expect(filterSchema.safeParse({ dataset: "hdfs" }).success).toBe(true)
    // A level with a space or too long is still rejected.
    expect(filterSchema.safeParse({ levels: ["a b"] }).success).toBe(false)
  })
})

describe("validateFilter", () => {
  it("accepts a valid window", () => {
    expect(validateFilter({ dataset: "bgl", ...window })).toBeNull()
    expect(validateFilter({})).toBeNull()
  })

  it("requires from < to, compared as instants", () => {
    expect(issuePaths({ from: window.to, to: window.from })).toEqual(["to"])
    expect(issuePaths({ from: window.from, to: window.from })).toEqual(["to"])
    // Same instant written with an offset.
    expect(
      issuePaths({
        from: "2005-06-03T02:00:00+02:00",
        to: "2005-06-03T00:00:00Z",
      })
    ).toEqual(["to"])
  })

  it("rejects more than microsecond precision", () => {
    expect(issuePaths({ from: "2005-06-03T00:00:00.1234567Z" })).toEqual([
      "from",
    ])
  })

  it("rejects fields of the other dataset", () => {
    expect(
      issuePaths({
        dataset: "openstack",
        node: "R02-M1-N0-C:J12-U11",
        only_alerts: true,
      })
    ).toEqual(["node", "only_alerts"])
    expect(issuePaths({ dataset: "bgl", request_id: "req-1" })).toEqual([
      "request_id",
    ])
    expect(issuePaths({ rack: "R02", instance_id: "abc" })).toEqual([""])
    expect(
      issuePaths({
        dataset: "bgl",
        endpoints: ["/v2/<ID>/servers/detail"],
        http_status: { min: 500, max: 599 },
      })
    ).toEqual(["endpoints", "http_status"])
  })

  it("accepts the extension fields for their own datasets", () => {
    expect(
      validateFilter({ dataset: "hdfs", block_id: "blk_-1608999687919862906" })
    ).toBeNull()
    expect(
      validateFilter({ dataset: "openssh", host: "LabSZ", process_id: "24200" })
    ).toBeNull()
    expect(
      validateFilter({ dataset: "apache", client_ip: "173.234.31.186" })
    ).toBeNull()
    expect(
      validateFilter({ dataset: "zookeeper", thread: "SendWorker:1" })
    ).toBeNull()
  })

  it("rejects an extension field for a dataset without its column", () => {
    expect(issuePaths({ dataset: "bgl", block_id: "blk_1" })).toEqual([
      "block_id",
    ])
    // host belongs to OpenSSH and Linux, not ZooKeeper.
    expect(issuePaths({ dataset: "zookeeper", host: "combo" })).toEqual([
      "host",
    ])
    // thread belongs to ZooKeeper only.
    expect(issuePaths({ dataset: "openssh", thread: "t" })).toEqual(["thread"])
  })

  it("rejects extension fields that no single dataset shares, without a dataset", () => {
    // block_id is HDFS-only and thread is ZooKeeper-only: no shared dataset.
    expect(issuePaths({ block_id: "blk_1", thread: "t" })).toEqual([""])
    // host (OpenSSH, Linux) and client_ip (OpenSSH, Apache) share OpenSSH.
    expect(
      validateFilter({ host: "LabSZ", client_ip: "173.234.31.186" })
    ).toBeNull()
  })

  it("rejects only_errors on a dataset without an error definition (linux)", () => {
    expect(issuePaths({ dataset: "linux", only_errors: true })).toEqual([
      "only_errors",
    ])
    // HDFS has an error definition (even if zero error events occur).
    expect(validateFilter({ dataset: "hdfs", only_errors: true })).toBeNull()
    // Without a dataset only_errors is allowed; the note names unknowns later.
    expect(validateFilter({ only_errors: true })).toBeNull()
  })

  it("accepts an inclusive status range only with min ≤ max", () => {
    expect(validateFilter({ http_status: { min: 503, max: 503 } })).toBeNull()
    expect(issuePaths({ http_status: { min: 500, max: 499 } })).toEqual([
      "http_status",
    ])
    expect(
      filterSchema.safeParse({ http_status: { min: 99, max: 200 } }).success
    ).toBe(false)
    expect(
      filterSchema.safeParse({ http_status: { min: 400, max: 499.5 } }).success
    ).toBe(false)
  })
})

describe("pickFilter", () => {
  it("keeps declaration order and names the same fields in the summary", () => {
    const picked = pickFilter(["text", "dataset", "to", "from"])
    expect(picked.fields).toEqual(["dataset", "from", "to", "text"])
    expect(Object.keys(picked.shape)).toEqual(["dataset", "from", "to", "text"])
    expect(picked.summary).toBe(
      "Accepted filters: dataset, from, to, text. Other fields are rejected with invalid_input."
    )
  })

  it("builds strict tool inputs that reject unpicked filters", () => {
    const input = z.strictObject({
      ...pickFilter(["dataset", "from", "to"]).shape,
      limit: z.number(),
    })
    expect(input.safeParse({ dataset: "bgl", limit: 5 }).success).toBe(true)
    expect(
      input.safeParse({ dataset: "bgl", limit: 5, node: "x" }).success
    ).toBe(false)
  })
})
