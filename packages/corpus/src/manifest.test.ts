import { describe, expect, it } from "vitest"

import {
  canonicalJson,
  dataVersion,
  sqlDigest,
  type ManifestInput,
} from "./manifest.ts"
import { VERSIONS } from "./versions.ts"

const input: ManifestInput = {
  source: "corpus",
  datasets: ["bgl", "openstack"],
  files: [{ path: "BGL.log", bytes: 10, sha256: "ab" }],
  image: "serenedb/serenedb:1@sha256:00",
  imageId: "sha256:01",
  serverVersion: "PostgreSQL 18.3 (SereneDB 1)",
  versions: VERSIONS,
  sqlDigest: "cd",
}

describe("canonicalJson", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }, 4] })).toBe(
      '{"a":[{"c":3,"d":2},4],"b":1}'
    )
  })

  it("drops undefined members like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}')
  })
})

describe("dataVersion", () => {
  it("is stable for equal content regardless of key order", () => {
    const reordered = {
      sqlDigest: "cd",
      datasets: ["bgl", "openstack"],
      versions: VERSIONS,
      image: input.image,
      serverVersion: input.serverVersion,
      imageId: input.imageId,
      files: input.files,
      source: "corpus",
    }
    expect(dataVersion(reordered)).toBe(dataVersion(input))
    expect(dataVersion(input)).toMatch(/^dv_[0-9a-f]{16}$/)
  })

  it("changes with a file digest, the image, its ID, the server, the SQL, the source or the datasets", () => {
    const base = dataVersion(input)
    const changed: ManifestInput[] = [
      { ...input, files: [{ path: "BGL.log", bytes: 10, sha256: "ac" }] },
      { ...input, image: "serenedb/serenedb:2@sha256:00" },
      { ...input, imageId: "sha256:02" },
      { ...input, serverVersion: "PostgreSQL 18.3 (SereneDB 2)" },
      { ...input, sqlDigest: "ce" },
      { ...input, source: "samples" },
      { ...input, datasets: ["bgl", "openstack", "hdfs"] },
    ]
    for (const variant of changed) {
      expect(dataVersion(variant)).not.toBe(base)
    }
  })
})

describe("sqlDigest", () => {
  it("depends on file names, contents and order", () => {
    const a = { name: "01.sql", content: "SELECT 1" }
    const b = { name: "02.sql", content: "SELECT 2" }
    expect(sqlDigest([a, b])).toBe(sqlDigest([a, b]))
    expect(sqlDigest([a, b])).not.toBe(sqlDigest([b, a]))
    expect(sqlDigest([a])).not.toBe(
      sqlDigest([{ name: "01.sql", content: "SELECT 1 " }])
    )
    // The separator keeps name and content apart.
    expect(sqlDigest([{ name: "a", content: "bc" }])).not.toBe(
      sqlDigest([{ name: "ab", content: "c" }])
    )
  })
})
