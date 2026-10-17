import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { fileFacts, sniffContent } from "./download.ts"

const bytes = (text: string) => new TextEncoder().encode(text)

describe("sniffContent", () => {
  it("recognizes zip and gzip archives by their magic bytes", () => {
    expect(sniffContent(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe(
      "zip"
    )
    expect(sniffContent(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe("gzip")
  })

  it("recognizes an HTML page served instead of a file", () => {
    expect(sniffContent(bytes("\n  <!DOCTYPE html><html>"))).toBe("html")
    expect(sniffContent(bytes("<HTML><body>Forbidden"))).toBe("html")
  })

  it("treats a log file as other content", () => {
    expect(sniffContent(bytes("- 1117838570 2005.06.03 R02-M1-N0"))).toBe(
      "other"
    )
    expect(sniffContent(new Uint8Array())).toBe("other")
  })
})

describe("fileFacts", () => {
  let dir = ""
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "corpus-facts-"))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const facts = async (name: string, content: string) => {
    const path = join(dir, name)
    await writeFile(path, content)
    return fileFacts(path)
  }

  it("counts lines with and without a final newline", async () => {
    expect((await facts("a", "x\ny\n")).lines).toBe(2)
    expect((await facts("b", "x\ny")).lines).toBe(2)
    expect((await facts("c", "x\n\ny\n")).lines).toBe(3)
    expect((await facts("d", "")).lines).toBe(0)
  })

  it("reports size and SHA-256", async () => {
    // SHA-256 of "abc" (FIPS 180-2 test vector).
    expect(await facts("e", "abc")).toEqual({
      bytes: 3,
      lines: 1,
      sha256:
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    })
  })
})
