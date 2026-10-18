import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { compareClaim } from "@workspace/domain/claims"
import { receiptSchema, type Receipt } from "@workspace/domain/receipt"
import {
  claimSchema,
  checkClaimsOutputSchema,
} from "@workspace/domain/tools/check-claims"
import { expect, it } from "vitest"
import { z } from "zod"

import { findWorkspaceRoot } from "./config.ts"
import { receiptSignature, resultDigest } from "./receipts.ts"

it("binds the worked investigation, slides, claims and re-runs to complete original receipts", async () => {
  const root = findWorkspaceRoot()
  const directory = join(root, "submission/worked-investigation")
  const manifest = z
    .object({
      data_version: z.string(),
      code_commit: z.string().regex(/^[a-f0-9]{40}$/),
      model_calls: z.literal(0),
      holdout_accessed: z.literal(false),
      role_acceptance: z.literal("not_demonstrated"),
      steps: z.array(
        z.object({
          step: z.string(),
          tool: z.string(),
          input: z.unknown(),
          receipt: z
            .string()
            .regex(/^submission\/evidence\/r_[a-f0-9]{8}\.json$/),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          truncated: z.boolean(),
        })
      ),
      reruns: z.array(
        z.object({
          original: z.string(),
          rerun: z.string(),
          matches: z.object({
            signature: z.literal(true),
            data_version: z.literal(true),
            result_digest: z.literal(true),
          }),
        })
      ),
      claim_checks: z.array(z.string()),
    })
    .parse(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")))
  const receipts = new Map<string, Receipt>()
  for (const step of manifest.steps) {
    const bytes = await readFile(join(root, step.receipt))
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(step.sha256)
    const receipt = receiptSchema.parse(JSON.parse(bytes.toString("utf8")))
    expect(step.receipt).toBe(`submission/evidence/${receipt.receipt_id}.json`)
    expect(receipts.has(receipt.receipt_id)).toBe(false)
    receipts.set(receipt.receipt_id, receipt)
    expect(receipt.tool).toBe(step.tool)
    expect(receipt.input).toEqual(step.input)
    expect(receipt.truncated).toBe(step.truncated)
    expect(receipt.data_version).toBe(manifest.data_version)
    expect(receipt.signature).toBe(
      receiptSignature(receipt.tool, receipt.tool_version, receipt.input)
    )
    expect(receipt.result_digest).toBe(resultDigest(receipt.result))
    expect(receipt.sql.length === 0).toBe(receipt.tool === "check_claims")
  }
  const requireReceipt = (id: string) => {
    const receipt = receipts.get(id)
    if (receipt === undefined) throw new Error(`Receipt not exported: ${id}`)
    return receipt
  }
  for (const rerun of manifest.reruns) {
    const original = requireReceipt(rerun.original)
    const repeated = requireReceipt(rerun.rerun)
    expect(repeated.signature).toBe(original.signature)
    expect(repeated.data_version).toBe(original.data_version)
    expect(repeated.result_digest).toBe(original.result_digest)
  }
  expect(manifest.reruns).toHaveLength(3)
  const ledger = z
    .object({ claims: z.array(claimSchema) })
    .parse(JSON.parse(await readFile(join(directory, "claims.json"), "utf8")))
  const submitted = []
  for (const id of manifest.claim_checks) {
    const receipt = requireReceipt(id)
    expect(receipt.tool).toBe("check_claims")
    const result = checkClaimsOutputSchema.parse(receipt.result)
    expect(result.summary.mismatch).toBe(0)
    expect(result.summary.unresolved).toBe(0)
    expect(result.summary.verified).toBe(result.summary.checked)
    for (const checked of result.claims) {
      expect(checked.status).toBe("verified")
      submitted.push(checked.claim)
    }
  }
  expect(submitted).toEqual(ledger.claims)
  const facts = new Map(
    [...receipts.values()].flatMap((receipt) =>
      receipt.facts.map((fact) => [fact.id, fact] as const)
    )
  )
  for (const claim of ledger.claims) {
    const fact = facts.get(claim.fact)
    if (fact === undefined)
      throw new Error(`Claim fact not exported: ${claim.fact}`)
    expect(compareClaim(claim, fact)).toEqual({ status: "verified" })
  }
  const checkedIds = new Set(ledger.claims.map((claim) => claim.fact))
  for (const path of [
    "submission/worked-investigation.md",
    "presentation/worked-investigation.typ",
  ]) {
    const document = await readFile(join(root, path), "utf8")
    for (const [id] of document.matchAll(/r_[a-f0-9]{8}\.f\d+/g)) {
      const fact = facts.get(id)
      if (fact === undefined)
        throw new Error(`${path}: missing exported fact ${id}`)
      // Verification summaries cannot recursively submit themselves to another check.
      const summary = fact.path.startsWith("/result/summary/")
      expect(checkedIds.has(id) || summary, `${path}: unchecked ${id}`).toBe(
        true
      )
    }
  }
})
