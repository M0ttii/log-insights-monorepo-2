import { createHash } from "node:crypto"

import type { VERSIONS } from "./versions.ts"

type ManifestFile = { path: string; bytes: number; sha256: string }

export type ManifestInput = {
  source: string
  /** Loaded datasets in catalog order (U26). */
  datasets: readonly string[]
  files: readonly ManifestFile[]
  /** Image reference Compose started: tag, plus `@sha256:` registry digest if pinned. */
  image: string
  /** Docker image ID (config digest) of the running container; never a registry digest. */
  imageId: string
  /** `SELECT version()` of the server that ran the load. */
  serverVersion: string
  versions: typeof VERSIONS
  sqlDigest: string
  /**
   * Remote sources (LOG-35): per file the HEAD pin (size, ETag,
   * Last-Modified) or the fixture's SHA-256, the mapping version and the
   * reference window. Absent without a remote dataset, so base and
   * extension loads hash as before apart from the SQL digest.
   */
  externalSources?: ReadonlyArray<{
    dataset: string
    kind: string
    mapping_version: string
    reference: {
      glob: string
      files: readonly number[]
      from: string
      to: string
    }
    files: ReadonlyArray<{
      file_index: number
      location: string
      bytes: number
      etag: string | null
      last_modified: string | null
      sha256: string | null
    }>
  }>
  /**
   * The OTLP replay (LOG-35, D7): replay ID and time, the fixture pin and
   * the listener table. Absent without `--with otel_replay`. The replay
   * time is part of it (it is stored as every record's
   * observed_timestamp), so every replay load has its own data version.
   */
  replay?: {
    dataset: string
    replay_id: string
    replayed_at: string
    fixture: { path: string; bytes: number; sha256: string; records: number }
    listener: { database: string; table: string }
  }
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
 * manifest without created_at. The same files, image (reference and image
 * ID), server version, rule versions and SQL give
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
