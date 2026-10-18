import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, mkdtemp, open, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as WebReadableStream } from "node:stream/web"

import * as tar from "tar"
import yauzl from "yauzl"

import {
  joinPosix,
  pinnedFiles,
  type Archive,
  type PinnedFile,
  type Source,
} from "./sources.ts"

export type FileFacts = {
  bytes: number
  sha256: string
  /** Newline-terminated lines, plus one for a last line without newline. */
  lines: number
}

export type RawFile = PinnedFile & {
  kind: "archive" | "extracted" | "download"
  lines: number
  /** True if this run downloaded or extracted the file. */
  fetched: boolean
}

type Log = (message: string) => void

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000

// Zenodo answers Node's default user agent with 403 and an HTML page
// (observed 17.10.2026); a named client is served the file.
const USER_AGENT = "log-insights-data-setup/1.0"

/** Size, SHA-256 and line count of a file in one streaming pass. */
export async function fileFacts(path: string): Promise<FileFacts> {
  const hash = createHash("sha256")
  let bytes = 0
  let newlines = 0
  let last = -1
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer
    hash.update(buffer)
    bytes += buffer.length
    for (
      let i = buffer.indexOf(0x0a);
      i !== -1;
      i = buffer.indexOf(0x0a, i + 1)
    ) {
      newlines++
    }
    last = buffer.at(-1) ?? last
  }
  const lines = bytes > 0 && last !== 0x0a ? newlines + 1 : newlines
  return { bytes, sha256: hash.digest("hex"), lines }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

/** Fails unless a file has exactly the pinned size and digest. */
async function verify(path: string, pinned: PinnedFile): Promise<FileFacts> {
  const facts = await fileFacts(path)
  if (facts.bytes !== pinned.bytes || facts.sha256 !== pinned.sha256) {
    throw new Error(
      `${pinned.path}: expected ${pinned.bytes} bytes with SHA-256 ${pinned.sha256}, ` +
        `found ${facts.bytes} bytes with ${facts.sha256}. ` +
        `Delete the file to download it again.`
    )
  }
  return facts
}

/**
 * Recognizes what a download actually contains from its first bytes. Zenodo
 * answers some requests (missing ?download=1, rate limits) with an HTML page
 * and status 200, which must not be mistaken for the archive.
 */
export function sniffContent(
  head: Uint8Array
): "zip" | "gzip" | "html" | "other" {
  if (
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    head[2] === 0x03 &&
    head[3] === 0x04
  ) {
    return "zip"
  }
  if (head[0] === 0x1f && head[1] === 0x8b) return "gzip"
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(head.subarray(0, 512))
    .trimStart()
    .toLowerCase()
  if (text.startsWith("<!doctype html") || text.startsWith("<html")) {
    return "html"
  }
  return "other"
}

async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r")
  try {
    const buffer = new Uint8Array(512)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Downloads to `<target>.part`, checks content and digest, then renames atomically. */
async function download(
  url: string,
  target: string,
  pinned: PinnedFile,
  expected: "zip" | "gzip" | "other",
  log: Log
): Promise<void> {
  log(`  downloading ${pinned.path} from ${url}`)
  const part = `${target}.part`
  await mkdir(dirname(target), { recursive: true })
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
    if (!response.ok || response.body === null) {
      throw new Error(
        `HTTP ${response.status} (${response.headers.get("content-type") ?? "no content type"}) for ${url}`
      )
    }
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      createWriteStream(part, { flags: "w" })
    )
    const kind = sniffContent(await readHead(part))
    if (kind === "html") {
      throw new Error(
        `${url} returned an HTML page instead of ${pinned.path} ` +
          `(content-type ${response.headers.get("content-type") ?? "unknown"}); ` +
          `retry later or download it manually into .data/raw`
      )
    }
    if (kind !== expected) {
      throw new Error(
        `${url} did not return a ${expected} file (found ${kind})`
      )
    }
    await verify(part, pinned)
    await rename(part, target)
  } catch (error) {
    await rm(part, { force: true })
    throw error
  }
}

async function extractZip(
  archivePath: string,
  wanted: ReadonlyMap<string, string>,
  log: Log
): Promise<string[]> {
  const zip = await yauzl.openPromise(archivePath, { lazyEntries: true })
  const names: string[] = []
  try {
    for await (const entry of zip.eachEntry()) {
      names.push(entry.fileName)
      const target = wanted.get(entry.fileName)
      if (target === undefined) continue
      log(`  extracting ${entry.fileName}`)
      const part = `${target}.part`
      try {
        await pipeline(
          await zip.openReadStreamPromise(entry),
          createWriteStream(part, { flags: "w" })
        )
        await rename(part, target)
      } catch (error) {
        await rm(part, { force: true })
        throw error
      }
    }
  } finally {
    zip.close()
  }
  return names
}

async function extractTarGz(
  archivePath: string,
  wanted: ReadonlyMap<string, string>,
  log: Log
): Promise<string[]> {
  const names: string[] = []
  await tar.list({
    file: archivePath,
    onReadEntry: (entry) => {
      names.push(entry.path)
    },
  })
  // Extract into a temporary directory next to the targets, then rename, so
  // an interrupted run never leaves a truncated file under its final name.
  const firstTarget = wanted.values().next().value
  if (firstTarget === undefined) return names
  const scratch = await mkdtemp(join(dirname(firstTarget), ".extract-"))
  try {
    await tar.extract({
      file: archivePath,
      cwd: scratch,
      filter: (path) => wanted.has(path),
    })
    for (const [name, target] of wanted) {
      log(`  extracting ${name}`)
      await rename(join(scratch, name), target)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  return names
}

/** Downloads (if missing) and extracts an archive; returns the archive's entry names. */
async function ensureArchive(
  rawDir: string,
  archive: Archive,
  log: Log
): Promise<{ fetched: Set<string>; entries: string[] | null }> {
  const fetched = new Set<string>()
  const targets = new Map(
    archive.entries.map((entry) => [
      entry.path,
      join(rawDir, joinPosix(archive.extractTo, entry.path)),
    ])
  )
  const missing = new Map<string, string>()
  for (const [name, target] of targets) {
    if (!(await exists(target))) missing.set(name, target)
  }
  if (missing.size === 0) return { fetched, entries: null }

  const archivePath = join(rawDir, archive.path)
  if (!(await exists(archivePath))) {
    await download(
      archive.url,
      archivePath,
      archive,
      archive.format === "zip" ? "zip" : "gzip",
      log
    )
    fetched.add(archive.path)
  } else {
    await verify(archivePath, archive)
  }

  await mkdir(join(rawDir, archive.extractTo), { recursive: true })
  // Entries can sit in subdirectories (HDFS_v1.zip: preprocessed/…).
  for (const target of missing.values())
    await mkdir(dirname(target), { recursive: true })
  const entries =
    archive.format === "zip"
      ? await extractZip(archivePath, missing, log)
      : await extractTarGz(archivePath, missing, log)
  const absent = archive.entries
    .map((entry) => entry.path)
    .filter((name) => !entries.includes(name))
  if (absent.length > 0) {
    throw new Error(
      `${archive.path} lacks expected entries: ${absent.join(", ")} (found ${entries.join(", ")})`
    )
  }
  for (const name of missing.keys()) {
    fetched.add(joinPosix(archive.extractTo, name))
  }
  log(`  ${archive.path} contains: ${entries.join(", ")}`)
  return { fetched, entries }
}

/**
 * Makes every file of the source present below `rawDir`, downloading and
 * extracting only what is missing, and verifies all of them against their
 * pinned size and SHA-256. Needs no system tools besides Node.
 */
export async function ensureSourceFiles(
  source: Source,
  rawDir: string,
  log: Log
): Promise<RawFile[]> {
  const fetched = new Set<string>()
  for (const archive of source.archives) {
    const result = await ensureArchive(rawDir, archive, log)
    for (const path of result.fetched) fetched.add(path)
  }
  for (const file of source.downloads) {
    const target = join(rawDir, file.path)
    if (await exists(target)) continue
    await download(file.url, target, file, "other", log)
    fetched.add(file.path)
  }

  const files: RawFile[] = []
  for (const pinned of pinnedFiles(source)) {
    const path = join(rawDir, pinned.path)
    // An archive that was deleted after extraction is not needed again.
    if (pinned.kind === "archive" && !(await exists(path))) continue
    const facts = await verify(path, pinned)
    files.push({
      ...pinned,
      lines: facts.lines,
      fetched: fetched.has(pinned.path),
    })
  }
  return files
}
