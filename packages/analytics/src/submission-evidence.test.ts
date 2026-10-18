import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { receiptSchema } from "@workspace/domain/receipt"
import { expect, it } from "vitest"
import { z } from "zod"

import { findWorkspaceRoot } from "./config.ts"
import { receiptSignature, resultDigest } from "./receipts.ts"

it("preserves complete original submission receipts bound by the saved SQL report", async () => {
  const root = findWorkspaceRoot()
  const report = z
    .object({
      sources: z.array(
        z.object({
          filename: z.string().regex(/^r_[0-9a-f]{8}\.json$/),
          sha256: z.string(),
        })
      ),
    })
    .parse(
      JSON.parse(
        await readFile(
          join(
            root,
            "submission/performance/historical-2026-10-18/report.json"
          ),
          "utf8"
        )
      )
    )
  expect(report.sources).toHaveLength(9)
  for (const source of report.sources) {
    const bytes = await readFile(
      join(root, "submission/evidence", source.filename)
    )
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(source.sha256)
    const receipt = receiptSchema.parse(JSON.parse(bytes.toString("utf8")))
    expect(`${receipt.receipt_id}.json`).toBe(source.filename)
    expect(receipt.signature).toBe(
      receiptSignature(receipt.tool, receipt.tool_version, receipt.input)
    )
    expect(receipt.result_digest).toBe(resultDigest(receipt.result))
  }
})
