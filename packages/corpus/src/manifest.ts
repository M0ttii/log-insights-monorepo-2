import { createHash } from "node:crypto"

import type { VERSIONS } from "./versions.ts"

type ManifestFile = { path: string; bytes: number; sha256: string }

export type ManifestInput = {
  source: string
  files: readonly ManifestFile[]
  image: string
  versions: typeof VERSIONS
  sqlDigest: string
}

/** JSON with object keys sorted at every level, so equal content hashes equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

/**
 * data_version: `dv_` + the first 16 hex digits of SHA-256 over the canonical
 * manifest without created_at. The same files, image, versions and SQL give
 * the same version on every run and machine.
 */
export function dataVersion(input: ManifestInput): string {
  const digest = createHash("sha256").update(canonicalJson(input)).digest("hex")
  return `dv_${digest.slice(0, 16)}`
}

/** SHA-256 over the executed SQL files, each as name and content, in plan order. */
export function sqlDigest(
  files: ReadonlyArray<{ name: string; content: string }>
): string {
  const hash = createHash("sha256")
  for (const { name, content } of files) {
    hash.update(name).update("\0").update(content).update("\0")
  }
  return hash.digest("hex")
}
