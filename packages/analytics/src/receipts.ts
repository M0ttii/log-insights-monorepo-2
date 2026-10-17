import { createHash, randomBytes } from "node:crypto"
import {
  link,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"

import { RECEIPT_ID_PATTERN } from "@workspace/domain/ids"
import {
  canonicalJson,
  receiptSchema,
  signaturePayload,
  type Receipt,
} from "@workspace/domain/receipt"
import type { ReceiptStore } from "@workspace/domain/tool"

/**
 * Receipt files (technical.md § 6.2): one JSON file per receipt, written by
 * the MCP process and the web app without coordination, because every ID is
 * its own file.
 */

const RECEIPT_FILE = /^(r_[0-9a-f]{8})\.json$/

/** `r_` and 8 random hex digits; the opaque handle between stateless calls. */
export function newReceiptId(): string {
  return `r_${randomBytes(4).toString("hex")}`
}

/** Query identity (S-12): SHA-256 over tool, version and validated input. */
export function receiptSignature(
  tool: string,
  toolVersion: string,
  input: unknown
): string {
  return sha256(signaturePayload(tool, toolVersion, input))
}

/** SHA-256 over the canonical JSON of the result. */
export function resultDigest(result: unknown): string {
  return sha256(canonicalJson(result))
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** `put` found a receipt with the same ID; the caller draws a new one. */
export class ReceiptIdTaken extends Error {
  constructor(readonly receiptId: string) {
    super(`receipt ${receiptId} already exists`)
    this.name = "ReceiptIdTaken"
  }
}

export class FileReceiptStore implements ReceiptStore {
  constructor(readonly dir: string) {}

  /**
   * Writes the complete file exclusively (`wx`) under a temporary name in the
   * same directory, then links it to its final name and removes the
   * temporary one. `link` is atomic like `rename` but never replaces an
   * existing file, so an ID collision surfaces as `ReceiptIdTaken` instead
   * of overwriting another process's receipt. Readers never see half a file.
   */
  async put(receipt: Receipt): Promise<void> {
    const id = checkId(receipt.receipt_id)
    const json = `${JSON.stringify(receiptSchema.parse(receipt), null, 2)}\n`
    await mkdir(this.dir, { recursive: true })
    const temporary = join(
      this.dir,
      `.${id}.${randomBytes(6).toString("hex")}.tmp`
    )
    await writeFile(temporary, json, { flag: "wx", mode: 0o644 })
    try {
      await link(temporary, this.path(id))
    } catch (error) {
      if (errorCode(error) === "EEXIST") throw new ReceiptIdTaken(id)
      throw error
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }

  /** `null` for a malformed or unknown ID; a corrupt file throws. */
  async get(id: string): Promise<Receipt | null> {
    if (!RECEIPT_ID_PATTERN.test(id)) return null
    let text: string
    try {
      text = await readFile(this.path(id), "utf8")
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null
      throw error
    }
    return receiptSchema.parse(JSON.parse(text))
  }

  /** Receipt IDs in code-point order; temporary files are skipped. */
  async list(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return []
      throw error
    }
    return names
      .map((name) => RECEIPT_FILE.exec(name)?.[1])
      .filter((id): id is string => id !== undefined)
      .toSorted()
  }

  /** The ID is validated before it forms a path (no traversal). */
  private path(id: string): string {
    return join(this.dir, `${checkId(id)}.json`)
  }
}

function checkId(id: string): string {
  if (!RECEIPT_ID_PATTERN.test(id))
    throw new RangeError(`invalid receipt ID: ${JSON.stringify(id)}`)
  return id
}

function errorCode(error: unknown): string | undefined {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code
  return undefined
}
