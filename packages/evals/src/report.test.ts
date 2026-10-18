import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { digest, exportAttempt, loadAttempt } from "./artifacts.ts"
import { recomputeReport } from "./report.ts"
import {
  checkReceipt,
  controlReceiptStore,
  knownPricing,
  rewriteAttempt,
  savedRound,
  sourceReceipt,
} from "./report-fixtures.ts"

const directories: string[] = []
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "log52-report-"))
  directories.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

describe("all-required-attempt acceptance", () => {
  it("advances a complete nonfixture offline control with definitive ratings", async () => {
    const dir = await directory()
    const { manifest, assessments } = await savedRound(dir)
    expect(manifest.fixture_only).toBe(false)
    expect(manifest.attempts).toHaveLength(38)
    const report = await recomputeReport(dir, "control", assessments)
    expect(report.measurement_complete).toBe(true)
    expect(
      report.attempts.every(
        (entry) => entry.evaluation?.product_status === "pass"
      )
    ).toBe(true)
    expect(report.groups.every((group) => group.rubric_mean === 2)).toBe(true)
    expect(report.acceptance).toBe("pending_external_acceptance")
  })

  it.each(["aborted", "error", "missing_receipts"] as const)(
    "blocks a required baseline marked %s despite definitive passing evaluation",
    async (failure) => {
      const dir = await directory()
      const { manifest, assessments } = await savedRound(dir)
      const plan = manifest.attempts.find(
        (attempt) => attempt.variant === "baseline"
      )
      if (plan === undefined) throw new Error("Missing baseline control")
      await rewriteAttempt(
        dir,
        plan.id,
        failure === "missing_receipts"
          ? { missing_receipts: ["r_99999999"] }
          : { status: failure, error_kind: "control_failure" }
      )
      const report = await recomputeReport(dir, "control", assessments)
      const entry = report.attempts.find(
        (attempt) => attempt.attempt_id === plan.id
      )
      expect(entry?.status).toBe(
        failure === "missing_receipts" ? "invalid" : failure
      )
      expect(entry?.evaluation?.product_status).toBe("pass")
      expect(entry?.evaluation?.rubric?.scope.score).toBe(2)
      expect(report.measurement_complete).toBe(false)
      expect(report.acceptance).toBe("not_demonstrated")
    }
  )

  it.each(["baseline", "playbook"] as const)(
    "applies acceptance quality criteria only to the playbook variant (%s control)",
    async (variant) => {
      const dir = await directory()
      const { manifest, assessments } = await savedRound(dir)
      const plan = manifest.attempts.find(
        (attempt) => attempt.variant === variant
      )
      if (plan === undefined) throw new Error("Missing baseline control")
      const assessment = assessments.find(
        (item) =>
          item.run_id === `run_${plan.order.toString(16).padStart(8, "0")}`
      )
      if (assessment === undefined || assessment.rubric === undefined)
        throw new Error("Missing definitive rating")
      assessment.dimensions.scope = {
        status: "fail",
        reason: "Independent negative baseline control.",
      }
      assessment.rubric.scope = {
        score: 0,
        reason: "Independent negative baseline control.",
      }
      const report = await recomputeReport(dir, "control", assessments)
      expect(report.measurement_complete).toBe(true)
      expect(
        report.attempts.find((entry) => entry.attempt_id === plan.id)
          ?.evaluation?.product_status
      ).toBe("fail")
      expect(report.acceptance).toBe(
        variant === "baseline" ? "pending_external_acceptance" : "failed"
      )
    }
  )
})

describe("all-attempt cost accounting", () => {
  it("preserves unknown cost for a group containing only an error", async () => {
    const dir = await directory()
    const { manifest, assessments } = await savedRound(dir)
    const plan = manifest.attempts.find(
      (attempt) =>
        attempt.question_id === "control-routing" &&
        attempt.variant === "baseline"
    )
    if (plan === undefined) throw new Error("Missing routing control")
    await rewriteAttempt(dir, plan.id, {
      status: "error",
      error_kind: "control_failure",
    })
    const report = await recomputeReport(dir, "control", assessments)
    const group = report.groups.find(
      (entry) =>
        entry.role === "routing_control" && entry.variant === "baseline"
    )
    expect(group).toMatchObject({
      planned: 1,
      completed: 0,
      estimated_cost: null,
    })
  })

  it("includes the known cache-aware cost of a failed attempt in a mixed group", async () => {
    const dir = await directory()
    const { manifest, assessments } = await savedRound(dir, knownPricing)
    const plan = manifest.attempts.find(
      (attempt) =>
        attempt.question_id === "control-engineer-1" &&
        attempt.variant === "baseline"
    )
    if (plan === undefined) throw new Error("Missing engineer control")
    await rewriteAttempt(dir, plan.id, {
      status: "error",
      error_kind: "control_failure",
    })
    const report = await recomputeReport(dir, "control", assessments)
    expect(
      report.attempts.find((entry) => entry.attempt_id === plan.id)
        ?.estimated_cost
    ).toBeCloseTo(0.00179, 10)
    const group = report.groups.find(
      (entry) => entry.role === "engineer" && entry.variant === "baseline"
    )
    expect(group).toMatchObject({ planned: 6, completed: 5 })
    expect(group?.estimated_cost).toBeCloseTo(0.01074, 10)
  })

  it("preserves unknown cost when a required attempt is missing", async () => {
    const dir = await directory()
    const { manifest, assessments } = await savedRound(dir, knownPricing)
    const plan = manifest.attempts.find(
      (attempt) => attempt.variant === "baseline"
    )
    if (plan === undefined) throw new Error("Missing baseline control")
    await unlink(join(dir, `attempts/${plan.id}.json`))
    const report = await recomputeReport(dir, "control", assessments)
    expect(
      report.groups.find(
        (entry) => entry.role === "engineer" && entry.variant === "baseline"
      )?.estimated_cost
    ).toBeNull()
  })
})

describe("receipt-bearing offline export and replay", () => {
  it("copies the check's transitive source unchanged even without a direct run reference", async () => {
    const dir = await directory()
    const { manifest, assessments } = await savedRound(dir)
    const plan = manifest.attempts.find(
      (attempt) =>
        attempt.question_id === "control-routing" &&
        attempt.variant === "baseline"
    )
    if (plan === undefined) throw new Error("Missing routing control")
    const loaded = await loadAttempt(dir, plan)
    expect(
      loaded.record?.phases
        .flatMap((phase) => phase.steps)
        .map((step) => step.receipt_id)
    ).toEqual([checkReceipt.receipt_id])
    expect(loaded.record?.final_text).not.toContain(sourceReceipt.receipt_id)
    expect(loaded.receipts).toEqual([checkReceipt, sourceReceipt])
    // Start with an empty export so another attempt cannot supply the source.
    const isolated = await directory()
    if (loaded.record === null) throw new Error("Missing saved routing run")
    await exportAttempt({
      dir: isolated,
      plan,
      record: loaded.record,
      receipts: controlReceiptStore,
      started_at: loaded.record.started_at,
      finished_at: loaded.record.finished_at,
      elapsed_ms: loaded.record.duration_ms,
    })
    expect((await loadAttempt(isolated, plan)).receipts).toEqual([
      checkReceipt,
      sourceReceipt,
    ])
    expect(loaded.attempt.receipts).toEqual([
      {
        file: `receipts/${checkReceipt.receipt_id}.json`,
        sha256: digest(checkReceipt),
      },
      {
        file: `receipts/${sourceReceipt.receipt_id}.json`,
        sha256: digest(sourceReceipt),
      },
    ])
    expect(
      await readFile(
        join(isolated, `receipts/${sourceReceipt.receipt_id}.json`),
        "utf8"
      )
    ).toBe(`${JSON.stringify(sourceReceipt, null, 2)}\n`)
    expect(
      await readFile(
        join(isolated, `receipts/${checkReceipt.receipt_id}.json`),
        "utf8"
      )
    ).toBe(`${JSON.stringify(checkReceipt, null, 2)}\n`)
    expect(
      (await recomputeReport(dir, "control", assessments)).acceptance
    ).toBe("pending_external_acceptance")
  })

  it.each([
    ["source", "delete"],
    ["check", "delete"],
    ["source", "corrupt"],
    ["check", "corrupt"],
  ] as const)(
    "blocks passing replay after %s receipt %s",
    async (kind, mutation) => {
      const dir = await directory()
      const { manifest, assessments } = await savedRound(dir)
      const plan = manifest.attempts.find(
        (attempt) =>
          attempt.question_id === "control-routing" &&
          attempt.variant === "baseline"
      )
      if (plan === undefined) throw new Error("Missing routing control")
      const receipt = kind === "source" ? sourceReceipt : checkReceipt
      const path = join(dir, `receipts/${receipt.receipt_id}.json`)
      if (mutation === "delete") await unlink(path)
      else
        await writeFile(path, JSON.stringify({ ...receipt, duration_ms: 9999 }))
      await expect(loadAttempt(dir, plan)).rejects.toThrow(
        mutation === "delete" ? /ENOENT/ : /Receipt artifact hash differs/
      )
      const report = await recomputeReport(dir, "control", assessments)
      expect(report.measurement_complete).toBe(false)
      expect(report.acceptance).not.toBe("pending_external_acceptance")
      expect(
        report.attempts.find((entry) => entry.attempt_id === plan.id)?.status
      ).toBe(mutation === "delete" ? "missing" : "invalid")
    }
  )
})
