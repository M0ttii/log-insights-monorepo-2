import { describe, expect, it } from "vitest"

import { headPin, pinRemoteFiles, type HeadFetch } from "./remote.ts"
import { buildSource } from "./sources.ts"

/** A HEAD answer with the given headers. */
const answer =
  (status: number, headers: Record<string, string>): HeadFetch =>
  async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
  })

const FILE = {
  file_index: 0,
  location:
    "https://public-pme.s3.eu-west-3.amazonaws.com/text_bench/part_000.parquet",
}

describe("remote pins (LOG-35)", () => {
  it("pins Content-Length, ETag and Last-Modified from one HEAD", async () => {
    const pin = await headPin(
      FILE,
      answer(200, {
        "content-length": "40991166725",
        etag: '"a5a5b68a-1236"',
        "last-modified": "Sun, 15 Mar 2026 17:44:11 GMT",
      })
    )
    expect(pin).toEqual({
      file_index: 0,
      location: FILE.location,
      bytes: 40_991_166_725,
      etag: '"a5a5b68a-1236"',
      last_modified: "2026-03-15T17:44:11.000Z",
      sha256: null,
    })
  })

  it("stops the setup on an HTTP error or a missing header instead of pinning less", async () => {
    await expect(headPin(FILE, answer(404, {}))).rejects.toThrow("HTTP 404")
    await expect(
      headPin(
        FILE,
        answer(200, {
          "content-length": "10",
          "last-modified": "Sun, 15 Mar 2026 17:44:11 GMT",
        })
      )
    ).rejects.toThrow("no ETag")
    await expect(
      headPin(FILE, answer(200, { etag: "x", "last-modified": "nonsense" }))
    ).rejects.toThrow("Content-Length")
  })

  it("pins every allowlisted file in allowlist order, HEAD only", async () => {
    const load = buildSource("corpus", [], ["otel"]).external[0]
    if (load === undefined) throw new Error("no otel load")
    const methods = new Set<string>()
    const pins = await pinRemoteFiles(
      load,
      () => undefined,
      async (url, init) => {
        methods.add(init.method)
        // Answer out of order: the pins are sorted by file index.
        await new Promise((resolve) =>
          setTimeout(resolve, url.endsWith("000.parquet") ? 5 : 0)
        )
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name) =>
              ({
                "content-length": "100",
                etag: `"${url.slice(-12)}"`,
                "last-modified": "Sun, 15 Mar 2026 17:44:11 GMT",
              })[name] ?? null,
          },
        }
      }
    )
    expect([...methods]).toEqual(["HEAD"])
    expect(pins.map((pin) => pin.file_index)).toEqual(
      Array.from({ length: 50 }, (_, index) => index)
    )
    expect(pins.every((pin) => pin.location.startsWith("https://"))).toBe(true)
  })
})
