import { describe, expect, it } from "vitest"
import { loadQuestions, makePlan } from "./contracts.ts"

describe("predeclared evaluation plan", () => {
  it("loads the audited development bank and alternates paired variants", async () => {
    const bank = await loadQuestions()
    const repeated = ["dev-eng-01", "dev-tl-01", "dev-mgr-01"]
    const plan = makePlan(bank, repeated)
    expect(plan).toHaveLength((bank.questions.length + 6) * 2)
    expect(plan.slice(0, 4).map((p) => p.variant)).toEqual([
      "baseline",
      "playbook",
      "playbook",
      "baseline",
    ])
    expect(plan.filter((p) => p.question_id === repeated[0])).toHaveLength(6)
    expect(() => makePlan(bank, ["missing"])).toThrow(
      /Choose exactly one repeated question/
    )
  })
})

import { mkdtemp, readFile, rm, writeFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runFixtureRound } from "./runner.ts"
import { recomputeReport, saveReport } from "./report.ts"

describe("saved evaluation artifacts", () => {
  it("replays without any model or DB run and retains missing/error attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "log52-replay-"))
    const dir = join(root, "fixture")
    try {
      await runFixtureRound(dir)
      const original = JSON.parse(
        await readFile(join(dir, "reports/1.0.0.json"), "utf8")
      )
      expect(await recomputeReport(dir, "1.0.0")).toEqual(original)
      expect(original.acceptance).toBe("not_demonstrated")
      expect(original.attempts).toHaveLength(2)
      await expect(saveReport(dir, "1.0.0")).rejects.toThrow(/EEXIST/)
      await saveReport(dir, "reviewer-v2")
      expect(
        JSON.parse(await readFile(join(dir, "reports/1.0.0.json"), "utf8"))
      ).toEqual(original)
      const attemptFile = join(dir, "attempts/dev-clarify-01-baseline-1.json")
      const attempt = JSON.parse(await readFile(attemptFile, "utf8"))
      await writeFile(
        attemptFile,
        JSON.stringify({ ...attempt, status: "aborted" })
      )
      const aborted = await recomputeReport(dir, "test")
      expect(aborted.attempts[0]?.status).toBe("aborted")
      expect(aborted.measurement_complete).toBe(false)
      await unlink(attemptFile)
      const missing = await recomputeReport(dir, "test")
      expect(missing.attempts[0]?.status).toBe("missing")
      expect(missing.acceptance).not.toBe("pending_external_acceptance")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it("rejects tampered answers rather than silently re-evaluating them", async () => {
    const root = await mkdtemp(join(tmpdir(), "log52-integrity-")),
      dir = join(root, "fixture")
    try {
      await runFixtureRound(dir)
      const file = join(dir, "runs/run_00000001.json")
      const record = JSON.parse(await readFile(file, "utf8"))
      await writeFile(
        file,
        JSON.stringify({ ...record, final_text: "tampered" })
      )
      const report = await recomputeReport(dir, "test")
      expect(report.attempts[0]?.status).toBe("invalid")
      expect(report.measurement_complete).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
