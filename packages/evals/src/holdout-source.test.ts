import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { findWorkspaceRoot } from "@workspace/analytics/config"
import { createManifest, prepareRound, executeRound } from "./runner.ts"
import { loadQuestions } from "./contracts.ts"
import { REPEATED_QUESTIONS } from "./experiment.ts"

const git = vi.hoisted(() => ({
  files: "README.md\0",
  status: "",
  commit: "synthetic-source-control",
}))
vi.mock("node:child_process", () => ({
  execFileSync: (_command: string, args: string[]) => {
    if (args[0] === "ls-files") return git.files
    if (args[0] === "status") return git.status
    if (args[0] === "rev-parse") return git.commit
    throw new Error("No external runtime is allowed in the source control")
  },
}))

async function snapshot() {
  return createManifest({
    root: findWorkspaceRoot(),
    round_id: "synthetic-source-control",
    bank: await loadQuestions(),
    data_version: "dv_syntheticSource",
    repeated: REPEATED_QUESTIONS,
    experiment: true,
  })
}

describe("evaluation source excludes only separately bound data", () => {
  it("keeps development bound to its exact commit even when executable source hashes agree", async () => {
    const root = await mkdtemp(join(tmpdir(), "log55-dev-head-control-"))
    git.files = "README.md\0"
    git.status = ""
    git.commit = "synthetic-frozen-commit"
    try {
      const before = await prepareRound(
        join(root, "development"),
        "dv_syntheticSource"
      )
      git.commit = "synthetic-new-empty-commit"
      const after = await snapshot()
      expect(after.versions.code_sha256).toBe(before.versions.code_sha256)
      await expect(
        executeRound(join(root, "development"), new AbortController().signal)
      ).rejects.toThrow(/Prepared configuration changed/)
    } finally {
      git.commit = "synthetic-source-control"
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps prepared plan/runtime artifacts and released YAML from invalidating their own code snapshot", async () => {
    git.files = "README.md\0"
    git.status = ""
    const before = await snapshot()
    // These deliberately nonexistent files must never be opened as source.
    git.files +=
      "packages/evals/results/synthetic/manifest.json\0packages/evals/results/synthetic/runtime.json\0vendor/synthetic\0packages/evals/questions/holdout-synthetic.yaml\0"
    git.status =
      "?? packages/evals/results/synthetic/manifest.json\0?? packages/evals/results/synthetic/runtime.json\0 M vendor/synthetic\0?? packages/evals/questions/holdout-synthetic.yaml\0"
    const after = await snapshot()
    expect(after.versions.code_sha256).toBe(before.versions.code_sha256)
    expect(before.versions.code_dirty).toBe(false)
    expect(after.versions.code_dirty).toBe(false)
  })

  it.each([
    "packages/evals/src/runner.ts",
    "packages/evals/questions/dev.yaml",
    "packages/evals/questions/holdout-synthetic.ts",
    "packages/evals/questions/holdout-../unsafe.yaml",
  ])("retains unrelated dirty source %s", async (path) => {
    git.files = "README.md\0"
    git.status = ` M ${path}\0`
    expect((await snapshot()).versions.code_dirty).toBe(true)
  })
})
