import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { runRecordSchema, type RunRecord } from "@workspace/agent/ai-sdk"
import { resultDigest } from "@workspace/analytics/receipts"
import { extractCitations } from "@workspace/domain/answer"
import {
  canonicalJson,
  receiptSchema,
  type Receipt,
} from "@workspace/domain/receipt"
import type { ReceiptStore } from "@workspace/domain/tool"
import {
  EVAL_VERSION,
  attemptSchema,
  type EvalAttempt,
  type PlannedAttempt,
} from "./contracts.ts"

export const digest = resultDigest
export async function writeArtifact(
  dir: string,
  file: string,
  value: unknown
): Promise<string> {
  const target = join(dir, file)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" })
  return digest(value)
}
export async function readArtifact(
  dir: string,
  file: string
): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, file), "utf8"))
}
export async function exportAttempt(input: {
  dir: string
  plan: PlannedAttempt
  record: RunRecord | null
  receipts: ReceiptStore
  started_at: string
  finished_at: string
  elapsed_ms: number
  error_kind?: string
  aborted?: boolean
}): Promise<EvalAttempt> {
  const { dir, plan, receipts } = input
  const record =
    input.record === null ? null : runRecordSchema.parse(input.record)
  let recordReference: EvalAttempt["record"] = null
  if (record !== null) {
    // Signed thinking/private model history is not an eval artifact. Answer
    // drafts, inputs, variant instructions and usage are explicitly exported.
    const { model_history: privateHistory, ...publicRecord } = record
    void privateHistory
    const file = `runs/${record.run_id}.json`
    recordReference = {
      file,
      sha256: await writeArtifact(dir, file, publicRecord),
    }
  }
  const pending = new Set<string>()
  for (const phase of record?.phases ?? [])
    for (const step of phase.steps)
      if (step.receipt_id !== null) pending.add(step.receipt_id)
  for (const citation of extractCitations(record?.final_text ?? ""))
    pending.add(citation.receiptId)
  const references: EvalAttempt["receipts"] = []
  const missing: string[] = []
  for (const receiptId of pending) {
    const receipt = await receipts.get(receiptId)
    if (receipt === null) {
      missing.push(receiptId)
      continue
    }
    receiptSchema.parse(receipt)
    if (resultDigest(receipt.result) !== receipt.result_digest)
      throw new Error("Receipt result digest differs")
    if (receipt.tool === "check_claims") {
      // Preserve transitive evidence even if the answer omitted its citation.
      const data = receipt.result
      if (
        data !== null &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        Array.isArray(data.claims)
      ) {
        for (const entry of data.claims) {
          if (
            entry !== null &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            entry.receipt !== null &&
            typeof entry.receipt === "object" &&
            !Array.isArray(entry.receipt) &&
            typeof entry.receipt.receipt_id === "string"
          )
            pending.add(entry.receipt.receipt_id)
        }
      }
    }
    const file = `receipts/${receipt.receipt_id}.json`
    try {
      await writeArtifact(dir, file, receipt)
    } catch (error) {
      if (digest(await readArtifact(dir, file)) !== digest(receipt)) throw error
    }
    references.push({ file, sha256: digest(receipt) })
  }
  const attempt = attemptSchema.parse({
    schema_version: EVAL_VERSION,
    plan,
    started_at: input.started_at,
    finished_at: input.finished_at,
    elapsed_ms: input.elapsed_ms,
    status:
      input.aborted === true
        ? "aborted"
        : record?.status === "completed"
          ? "completed"
          : "error",
    error_kind: input.error_kind ?? record?.error_kind ?? null,
    record: recordReference,
    receipts: references,
    missing_receipts: missing,
  })
  await writeArtifact(dir, `attempts/${plan.id}.json`, attempt)
  return attempt
}
export async function loadAttempt(
  dir: string,
  plan: PlannedAttempt
): Promise<{
  attempt: EvalAttempt
  record: RunRecord | null
  receipts: Receipt[]
}> {
  const attempt = attemptSchema.parse(
    await readArtifact(dir, `attempts/${plan.id}.json`)
  )
  if (canonicalJson(attempt.plan) !== canonicalJson(plan))
    throw new Error("Attempt does not match manifest")
  const recordValue =
    attempt.record === null
      ? null
      : await readArtifact(dir, attempt.record.file)
  if (attempt.record !== null && digest(recordValue) !== attempt.record.sha256)
    throw new Error("Run artifact hash differs")
  const record =
    recordValue === null ? null : runRecordSchema.parse(recordValue)
  const receipts: Receipt[] = []
  for (const reference of attempt.receipts) {
    const value = await readArtifact(dir, reference.file)
    if (digest(value) !== reference.sha256)
      throw new Error("Receipt artifact hash differs")
    const receipt = receiptSchema.parse(value)
    if (resultDigest(receipt.result) !== receipt.result_digest)
      throw new Error("Receipt result digest differs")
    receipts.push(receipt)
  }
  return { attempt, record, receipts }
}
