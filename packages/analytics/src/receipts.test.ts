import { createHash } from "node:crypto"
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Receipt } from "@workspace/domain/receipt"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  FileReceiptStore,
  newReceiptId,
  ReceiptIdTaken,
  receiptSignature,
  resultDigest,
} from "./receipts.ts"

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

function receipt(id: string, overrides: Partial<Receipt> = {}): Receipt {
  return {
    receipt_id: id,
    created_at: "2026-10-17T12:00:00.000Z",
    client: "test",
    tool: "describe_corpus",
    tool_version: "1.0.0",
    input: {},
    signature: "a".repeat(64),
    data_version: "dv_0123456789abcdef",
    sql: ["SELECT 1"],
    params: [[]],
    scope: {
      windows: [
        {
          dataset: "bgl",
          from: "2005-06-03T22:42:50.675872Z",
          to: "2006-01-03T15:13:09.127919Z",
        },
      ],
      filters: {},
    },
    population: { count: 2000, unit: "log_events" },
    rows_returned: 1,
    truncated: false,
    row_limit: null,
    duration_ms: 1.5,
    result: { events: 2000 },
    result_digest: "b".repeat(64),
    facts: [],
    ...overrides,
  }
}

let dir: string
let store: FileReceiptStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "receipts-"))
  store = new FileReceiptStore(join(dir, "receipts"))
})

afterEach(async () => {
  await chmod(join(dir, "receipts"), 0o755).catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
})

describe("FileReceiptStore", () => {
  it("writes one JSON file per receipt and reads it back", async () => {
    await store.put(receipt("r_0000000a"))
    expect(await store.get("r_0000000a")).toEqual(receipt("r_0000000a"))
    const text = await readFile(
      join(dir, "receipts", "r_0000000a.json"),
      "utf8"
    )
    expect(JSON.parse(text)).toEqual(receipt("r_0000000a"))
  })

  it("leaves no temporary file behind and lists IDs in order", async () => {
    await store.put(receipt("r_000000b2"))
    await store.put(receipt("r_000000a1"))
    await writeFile(join(dir, "receipts", "notes.txt"), "ignored")
    expect(await readdir(join(dir, "receipts"))).toEqual([
      "notes.txt",
      "r_000000a1.json",
      "r_000000b2.json",
    ])
    expect(await store.list()).toEqual(["r_000000a1", "r_000000b2"])
  })

  it("never overwrites an existing receipt", async () => {
    await store.put(receipt("r_0000000c"))
    const second = store.put(receipt("r_0000000c", { duration_ms: 99 }))
    await expect(second).rejects.toBeInstanceOf(ReceiptIdTaken)
    expect((await store.get("r_0000000c"))?.duration_ms).toBe(1.5)
    expect(await readdir(join(dir, "receipts"))).toEqual(["r_0000000c.json"])
  })

  it("keeps every file of concurrent writers complete", async () => {
    const ids = Array.from(
      { length: 40 },
      (_, i) => `r_${i.toString(16).padStart(8, "0")}`
    )
    await Promise.all(ids.map((id) => store.put(receipt(id))))
    expect(await store.list()).toEqual(ids)
    for (const id of ids) expect(await store.get(id)).toEqual(receipt(id))
    expect(await readdir(join(dir, "receipts"))).toHaveLength(ids.length)
  })

  it("validates IDs before they form a path", async () => {
    for (const id of [
      "../etc/passwd",
      "r_0000000",
      "r_0000000G",
      "R_00000000",
      "r_00000000.json",
    ]) {
      expect(await store.get(id)).toBeNull()
      await expect(
        store.put(receipt("r_00000001", { receipt_id: id }))
      ).rejects.toThrow("invalid receipt ID")
    }
    expect(await store.list()).toEqual([])
  })

  it("returns null for unknown IDs and an empty list without a directory", async () => {
    expect(await store.get("r_deadbeef")).toBeNull()
    expect(await store.list()).toEqual([])
  })

  it("fails when the directory is not writable", async () => {
    await store.put(receipt("r_00000001"))
    await chmod(join(dir, "receipts"), 0o500)
    await expect(store.put(receipt("r_00000002"))).rejects.toThrow(/EACCES/)
    expect(await store.list()).toEqual(["r_00000001"])
  })
})

describe("IDs, signature and digest", () => {
  it("draws r_ plus 8 hex digits", () => {
    const ids = new Set(Array.from({ length: 200 }, newReceiptId))
    for (const id of ids) expect(id).toMatch(/^r_[0-9a-f]{8}$/)
    expect(ids.size).toBeGreaterThan(195)
  })

  it("hashes tool, version and input in canonical form", () => {
    const expected = sha256(
      '{"input":{"dataset":"bgl","top_n":20},"tool":"count_events","tool_version":"1.0.0"}'
    )
    expect(
      receiptSignature("count_events", "1.0.0", { top_n: 20, dataset: "bgl" })
    ).toBe(expected)
    expect(
      receiptSignature("count_events", "1.0.0", { dataset: "bgl", top_n: 20 })
    ).toBe(expected)
    expect(
      receiptSignature("count_events", "1.0.1", { dataset: "bgl", top_n: 20 })
    ).not.toBe(expected)
  })

  it("digests the canonical result", () => {
    expect(resultDigest({ b: [1, 2], a: "x" })).toBe(
      sha256('{"a":"x","b":[1,2]}')
    )
  })
})
