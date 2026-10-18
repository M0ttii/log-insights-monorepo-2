import { mkdtemp, rm, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readArtifact } from "./artifacts.ts"
import { prepareReview, recomputeDevelopmentReport } from "./development.ts"
import { savedRound } from "./report-fixtures.ts"

const directories: string[] = []
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "log53-review-"))
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

describe("saved development review pipeline", () => {
  it("prepares all attempts and two blind orders without leaking variant labels", async () => {
    const dir = await directory()
    await savedRound(dir)
    const prepared = await prepareReview(dir, "review-1")
    expect(prepared.assignments).toHaveLength(38)
    expect(prepared.pairs).toHaveLength(18)
    expect(prepared.unavailable).toEqual([])
    expect(prepared.human_policy.selected_pair_ids).toHaveLength(3)
    const publicPair = await readArtifact(
      dir,
      prepared.pair_packets[0]?.file ?? "missing"
    )
    expect(JSON.stringify(publicPair)).not.toContain('"variant"')
    expect(JSON.stringify(publicPair)).not.toContain(
      prepared.assignments[0]?.attempt_id ?? "missing-control"
    )
    await expect(prepareReview(dir, "review-1")).rejects.toThrow(/EEXIST/)
  })

  it("retains missing attempts and pairs instead of creating positive judgments", async () => {
    const dir = await directory()
    const { manifest } = await savedRound(dir)
    const plan = manifest.attempts[0]
    if (plan === undefined) throw new Error("Missing test attempt")
    await unlink(join(dir, `attempts/${plan.id}.json`))
    const prepared = await prepareReview(dir, "review-1")
    expect(prepared.assignments).toHaveLength(37)
    expect(prepared.pairs).toHaveLength(18)
    expect(prepared.unavailable).toEqual([
      { attempt_id: plan.id, error_kind: "missing_artifact" },
    ])
    const report = await recomputeDevelopmentReport(dir, "review-1", {
      judge_submissions: [],
      pair_judgments: [],
      human_reviews: [],
      s13_content: [],
    })
    expect(report.acceptance).toBe("not_demonstrated")
    expect(report.comparison.totals).toMatchObject({
      planned_pairs: 18,
      missing_pairs: 18,
    })
    expect(report.human.status).toBe("unknown")
    expect(report.common_cases).toEqual([])
  })
})
