import { describe, expect, it } from "vitest"

import {
  expectedServerVersion,
  isDigestPinned,
  LOCAL_IMAGES,
  validateImage,
} from "./image.ts"

const ID_A = `sha256:${"a".repeat(64)}`
const PINNED = `serenedb/serenedb:26.10.1@sha256:${"b".repeat(64)}`
const [local] = LOCAL_IMAGES

describe("validateImage", () => {
  it("accepts a reference pinned by registry digest with any image ID", () => {
    expect(validateImage({ reference: PINNED, imageId: ID_A })).toEqual({
      reference: PINNED,
      imageId: ID_A,
    })
  })

  it("accepts a listed local tag only with its listed image ID", () => {
    if (local === undefined) throw new Error("no local image listed")
    expect(
      validateImage({ reference: local.reference, imageId: local.imageId })
    ).toEqual({ reference: local.reference, imageId: local.imageId })
    expect(() =>
      validateImage({ reference: local.reference, imageId: ID_A })
    ).toThrow(/has image ID .* expected/)
  })

  it("rejects an unpinned tag that is not a listed local build", () => {
    expect(() =>
      validateImage({ reference: "serenedb/serenedb:26.10.1", imageId: ID_A })
    ).toThrow(/neither pinned by digest nor a verified local build/)
    expect(() =>
      validateImage({ reference: "local/serenedb:latest", imageId: ID_A })
    ).toThrow(/neither pinned/)
  })

  it("rejects a missing or malformed image ID, also for pinned references", () => {
    expect(() => validateImage({ reference: PINNED, imageId: "" })).toThrow(
      /no image ID/
    )
    // A registry digest is not an image ID: the prefix alone does not pass.
    expect(() =>
      validateImage({ reference: PINNED, imageId: "sha256:abc" })
    ).toThrow(/no image ID/)
  })
})

describe("isDigestPinned", () => {
  it("requires a full sha256 digest at the end of the reference", () => {
    expect(isDigestPinned(PINNED)).toBe(true)
    expect(isDigestPinned("serenedb/serenedb:26.10.1")).toBe(false)
    expect(isDigestPinned("serenedb/serenedb@sha256:00")).toBe(false)
    expect(isDigestPinned(local?.reference ?? "")).toBe(false)
  })
})

describe("expectedServerVersion", () => {
  it("is known for listed local builds only", () => {
    expect(expectedServerVersion(local?.reference ?? "")).toBe(
      "PostgreSQL 18.3 (SereneDB 26.10.1)"
    )
    expect(expectedServerVersion(PINNED)).toBeNull()
  })
})
