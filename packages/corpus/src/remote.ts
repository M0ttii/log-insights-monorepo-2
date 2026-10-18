import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { ExternalLoad } from "./sources.ts"

/**
 * Pins of remote Parquet files (LOG-35, design D4). The corpus files are
 * 41 GB each and never downloaded: a HEAD per allowlisted URL records
 * Content-Length, ETag and Last-Modified, which become part of the data
 * version; SQL then reads the footers (60_otel_sources.sql). With --samples
 * the committed fixtures are copied below .data/raw (verified by size and
 * SHA-256), so CI reads the same schema without network access.
 */

export type ExternalPin = {
  file_index: number
  /** HTTPS URL or container path, as the server reads it. */
  location: string
  bytes: number
  /** ETag of the HEAD; null for fixtures. */
  etag: string | null
  /** Last-Modified of the HEAD as ISO-8601 UTC; null for fixtures. */
  last_modified: string | null
  /** SHA-256 of a committed fixture; null for remote files. */
  sha256: string | null
}

type Log = (message: string) => void

/** The same named client as download.ts (Zenodo refuses Node's default). */
const USER_AGENT = "log-insights-data-setup/1.0"
const HEAD_TIMEOUT_MS = 20_000
/** Parallel HEAD requests; 50 files take about a second. */
const HEAD_CONCURRENCY = 8

export type HeadFetch = (
  url: string,
  init: { method: "HEAD"; headers: Record<string, string>; signal: AbortSignal }
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
}>

/** HEAD of one URL as a pin; throws on any missing header or HTTP error. */
export async function headPin(
  file: { file_index: number; location: string },
  fetchHead: HeadFetch = fetch
): Promise<ExternalPin> {
  const response = await fetchHead(file.location, {
    method: "HEAD",
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
  })
  if (!response.ok)
    throw new Error(`HEAD ${file.location} answered HTTP ${response.status}`)
  const length = response.headers.get("content-length")
  const etag = response.headers.get("etag")
  const modified = response.headers.get("last-modified")
  const bytes = Number(length)
  if (length === null || !Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error(`HEAD ${file.location} has no usable Content-Length`)
  if (etag === null || etag === "")
    throw new Error(`HEAD ${file.location} has no ETag`)
  const time = modified === null ? Number.NaN : Date.parse(modified)
  if (Number.isNaN(time))
    throw new Error(`HEAD ${file.location} has no usable Last-Modified`)
  return {
    file_index: file.file_index,
    location: file.location,
    bytes,
    etag,
    last_modified: new Date(time).toISOString(),
    sha256: null,
  }
}

/** HEAD pins of every remote file, in allowlist order. */
export async function pinRemoteFiles(
  load: ExternalLoad,
  log: Log,
  fetchHead: HeadFetch = fetch
): Promise<ExternalPin[]> {
  const pins: ExternalPin[] = []
  const queue = [...load.files]
  const worker = async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift())
      pins.push(await headPin(file, fetchHead))
  }
  await Promise.all(Array.from({ length: HEAD_CONCURRENCY }, worker))
  pins.sort((a, b) => a.file_index - b.file_index)
  log(
    `  pinned ${pins.length} remote files by HEAD (${pins.reduce((sum, pin) => sum + pin.bytes, 0).toLocaleString("en-US")} bytes, never downloaded)`
  )
  return pins
}

async function sha256Of(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

/**
 * Copies the committed fixtures below .data/raw when a copy is missing or
 * differs, and pins them by size and SHA-256. An unchanged copy keeps its
 * modification time, which read_blob reports as last_modified.
 */
export async function ensureFixtures(
  load: ExternalLoad,
  rawDir: string,
  corpusDir: string,
  log: Log
): Promise<ExternalPin[]> {
  const pins: ExternalPin[] = []
  for (const file of load.files) {
    const fixture = file.fixture
    if (fixture === null) throw new Error(`${file.location} is no fixture`)
    const committed = join(corpusDir, fixture.fixture)
    const copy = join(rawDir, fixture.path)
    if ((await sha256Of(committed)) !== fixture.sha256)
      throw new Error(`${fixture.fixture} does not match its catalog SHA-256`)
    const present = await stat(copy).then(
      (facts) => facts.size === fixture.bytes,
      () => false
    )
    const current = present && (await sha256Of(copy)) === fixture.sha256
    if (!current) {
      await mkdir(dirname(copy), { recursive: true })
      await copyFile(committed, copy)
    }
    log(
      `  ${current ? "present" : "copied "}  ${fixture.path}  ${fixture.bytes} bytes  sha256 ${fixture.sha256}`
    )
    pins.push({
      file_index: file.file_index,
      location: file.location,
      bytes: fixture.bytes,
      etag: null,
      last_modified: null,
      sha256: fixture.sha256,
    })
  }
  return pins
}
