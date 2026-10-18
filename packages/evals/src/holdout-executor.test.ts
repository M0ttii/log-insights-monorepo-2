import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
  rename,
  copyFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stringify } from "yaml"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { InvestigationInput } from "@workspace/agent/ai-sdk"
import * as holdoutFiles from "./holdout-files.ts"
import { digest, readArtifact, writeArtifact } from "./artifacts.ts"
import {
  loadQuestions,
  manifestSchema,
  type EvalManifest,
} from "./contracts.ts"
import { REPEATED_QUESTIONS } from "./experiment.ts"
import { sourceReceipt } from "./report-fixtures.ts"
import { holdoutPlan, holdoutMetadataSchema } from "./holdout.ts"
import { holdoutQuestionBankSchema } from "./holdout-questions.ts"
import {
  recomputeReport,
  loadRoundSnapshot,
  readHoldoutStatus,
} from "./report.ts"
import { prepareReview, saveDevelopmentReport } from "./development.ts"
import { createManifest } from "./runner.ts"
import {
  prepareHoldoutRound,
  executeHoldoutRound,
  verifyHoldoutQuestionCommit,
} from "./holdout-executor.ts"

// All content below is synthetic. Real Git ancestry is exercised; runtime,
// development acceptance, provider and database boundaries never leave memory.
const state = vi.hoisted(() => ({
  root: "",
  sourceRoot: "",
  current: null as EvalManifest | null,
  calls: [] as InvestigationInput[],
  runtime: {} as Record<string, unknown>,
  aborted: false,
  observed: 0,
  disposed: 0,
  onAttempt: () => {},
  statusTarget: "",
  statusReplaced: false,
  statusRawReads: 0,
  statusFdReadCounters: [] as (() => number)[],
  afterStatusRealpath: async (_path: unknown) => {},
}))
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>()
  return {
    ...actual,
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => {
      const result = await actual.realpath(path)
      await state.afterStatusRealpath(path)
      return result
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === state.statusTarget && state.statusReplaced)
        state.statusRawReads += 1
      return actual.readFile(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (String(args[0]) === state.statusTarget && state.statusReplaced) {
        const reads = vi.spyOn(handle, "read")
        state.statusFdReadCounters.push(() => reads.mock.calls.length)
      }
      return handle
    },
  }
})
vi.mock("@workspace/analytics/config", async (original) => {
  const actual = await original<typeof import("@workspace/analytics/config")>()
  state.sourceRoot = actual.findWorkspaceRoot()
  return {
    ...actual,
    findWorkspaceRoot: () => state.root || state.sourceRoot,
    loadConfig: () => ({ connection: {} }),
  }
})
vi.mock("./runner.ts", async (original) => ({
  ...(await original<typeof import("./runner.ts")>()),
  createManifest: vi.fn<typeof createManifest>(async () => {
    if (state.current === null)
      throw new Error("Missing synthetic configuration")
    return structuredClone(state.current)
  }),
}))
vi.mock("./development.ts", async (original) => ({
  ...(await original<typeof import("./development.ts")>()),
  recomputeDevelopmentReport: async () => ({
    acceptance: "passed",
    core: { measurement_complete: true, attempts: [{ status: "completed" }] },
  }),
}))
vi.mock("./holdout-runtime.ts", async (original) => ({
  ...(await original<typeof import("./holdout-runtime.ts")>()),
  observeEvalRuntime: async () => {
    state.observed += 1
    return structuredClone(state.runtime)
  },
}))
vi.mock("@workspace/analytics/db", () => ({
  createDatabase: () => ({
    timeoutMs: 10000,
    query: () => {
      throw new Error("Synthetic test forbids database access")
    },
    dispose: async () => {
      state.disposed += 1
    },
  }),
}))
vi.mock("@workspace/agent/ai-sdk", async (original) => {
  const actual = await original<typeof import("@workspace/agent/ai-sdk")>()
  return {
    ...actual,
    resolveModel: () => ({
      model: null,
      modelId: "claude-opus-5-5",
      effort: "high",
      providerOptions: {},
    }),
    runInvestigation: (input: InvestigationInput) => {
      state.calls.push(input)
      state.onAttempt()
      if (state.calls.length === 2)
        throw new Error("Synthetic provider failure must remain visible")
      const record = actual.runRecordSchema.parse({
        run_id: `run_${state.calls.length.toString(16).padStart(8, "0")}`,
        started_at: "2026-10-18T00:00:00.000Z",
        finished_at: "2026-10-18T00:00:00.001Z",
        duration_ms: 1,
        status: "stopped",
        variant: input.variant,
        role: { requested: input.role, effective: input.role },
        question: input.question,
        scope: input.scope,
        model_id: "claude-opus-5-5",
        effort: "high",
        guidance_version: "synthetic",
        contract_version: "synthetic",
        data_version: "dv_syntheticHoldout",
        instruction_texts: [],
        phases: [],
        coverage_requests: [],
        gate_findings: [],
        usage: {
          input: null,
          output: null,
          cache_read: null,
          cache_write: null,
        },
        final_text: null,
        check_claims: [],
        error_kind: null,
        model_calls: 0,
      })
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
        done: Promise.resolve(record),
      }
    },
  }
})
const dirs: string[] = []
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex")
const publicBank = {
  schema_version: 1,
  set_id: "synthetic-executor",
  questions: (["engineer", "team_lead", "manager"] as const).flatMap((role) =>
    [1, 2].map((n) => ({
      id: `synthetic-${role}-${n}`,
      role,
      question: `Synthetic ${role} boundary ${n}.`,
      scope: { dataset: n === 1 ? "bgl" : "openstack" },
    }))
  ),
}
function git(root: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "log55-synthetic-"))
  dirs.push(root)
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "synthetic@example.invalid"])
  git(root, ["config", "user.name", "Synthetic offline control"])
  await writeFile(join(root, ".gitignore"), ".data/\npackages/evals/results/\n")
  await writeFile(join(root, "README.md"), "Synthetic offline repository.\n")
  await writeFile(join(root, "pnpm-lock.yaml"), "synthetic-lock\n")
  git(root, ["add", ".gitignore", "README.md", "pnpm-lock.yaml"])
  git(root, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "synthetic frozen base",
  ])
  return { root, base: git(root, ["rev-parse", "HEAD"]) }
}
async function questionCommit(root: string) {
  const file = `holdout-${publicBank.set_id}.yaml`
  await mkdir(join(root, "packages/evals/questions"), { recursive: true })
  const bytes = stringify(publicBank)
  await writeFile(join(root, "packages/evals/questions", file), bytes)
  git(root, ["add", `packages/evals/questions/${file}`])
  git(root, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "synthetic released questions",
  ])
  return { file, hash: sha(bytes), head: git(root, ["rev-parse", "HEAD"]) }
}
async function fixture() {
  const repo = await repository()
  const runner =
    await vi.importActual<typeof import("./runner.ts")>("./runner.ts")
  const bank = await loadQuestions()
  const original = await runner.createManifest({
    root: state.sourceRoot,
    bank,
    round_id: "synthetic-development",
    data_version: "dv_syntheticHoldout",
    repeated: REPEATED_QUESTIONS,
    experiment: true,
  })
  const development = manifestSchema.parse({
    ...original,
    versions: {
      ...original.versions,
      code_commit: repo.base,
      code_dirty: false,
    },
  })
  const preparation = join(repo.root, ".data/preparation"),
    frozenDir = join(repo.root, ".data/freeze"),
    devDir = join(repo.root, ".data/development"),
    dir = join(repo.root, "packages/evals/results/first")
  const now = new Date().toISOString()
  const result = {
    datasets: [{ dataset: "bgl" }, { dataset: "openstack" }],
    versions: { data_version: "dv_syntheticHoldout", source: "corpus" },
  }
  const receipt = {
    ...sourceReceipt,
    receipt_id: "r_00000001",
    created_at: now,
    tool: "describe_corpus",
    data_version: "dv_syntheticHoldout",
    result,
    result_digest: digest(result),
  }
  const runtime = {
    observed_at: now,
    configured_image: "synthetic",
    running_image_id: `sha256:${"1".repeat(64)}`,
    published_port: 1,
    corpus_receipt_id: receipt.receipt_id,
    corpus_receipt_sha256: digest(receipt),
    data_version: "dv_syntheticHoldout",
    source: "corpus",
    datasets: ["bgl", "openstack"],
    lockfile_sha256: sha("synthetic-lock\n"),
  }
  const metadata = holdoutMetadataSchema.parse({
    schema_version: 1,
    set_id: publicBank.set_id,
    created_at: now,
    author_id: "synthetic-independent",
    author_not_playbook_author: true,
    sealed: true,
    contaminated: false,
    role_counts: { engineer: 2, team_lead: 2, manager: 2 },
    datasets: ["bgl", "openstack"],
    data_version: "dv_syntheticHoldout",
    files: {
      questions_sha256: "1".repeat(64),
      expectations_sha256: "2".repeat(64),
      evidence_sha256: "3".repeat(64),
    },
  })
  const registration = {
    schema_version: 1,
    registered_at: now,
    metadata_sha256: digest(metadata),
    metadata,
  }
  const review = {
    acceptance: "passed",
    core: { measurement_complete: true, attempts: [{ status: "completed" }] },
  }
  const frozen = {
    schema_version: 1,
    state: "frozen_before_release",
    frozen_at: now,
    metadata_sha256: digest(metadata),
    preparation_sha256: digest(registration),
    development: {
      directory: devDir,
      reviewer_version: "synthetic-review",
      manifest_sha256: digest(development),
      report_sha256: digest(review),
      review_input_sha256: digest({}),
    },
    configuration: development,
    lockfile_sha256: runtime.lockfile_sha256,
    runtime,
    plan: holdoutPlan(metadata),
    repeat_anchors: {
      split: "development",
      question_ids: REPEATED_QUESTIONS,
      trials_per_variant: 3,
      holdout_trials_per_variant: 1,
    },
    policy: {
      version: "log54-v1",
      comparison: "blind_both_orders",
      human_sample: "one_pair_per_role_and_all_critical_findings",
      error_policy: "retain_all_no_replacement_or_resume",
      acceptance: "unchanged_technical_13_1_per_split",
      inspection: "questions_become_regression_after_inspection",
    },
    limitations: ["Synthetic offline control only."],
  }
  const committed = await questionCommit(repo.root)
  const attempted = {
    schema_version: 1,
    state: "release_attempted",
    attempted_at: now,
    set_id: publicBank.set_id,
    freeze_sha256: digest(frozen),
    sealed_questions_sha256: metadata.files.questions_sha256,
    retry_policy: "fresh_set_required_after_any_attempt",
    expectations_released: false,
  }
  const released = {
    schema_version: 1,
    state: "released_known_questions",
    released_at: now,
    set_id: publicBank.set_id,
    freeze_sha256: digest(frozen),
    release_attempt_sha256: digest(attempted),
    sealed_questions_sha256: metadata.files.questions_sha256,
    public_questions_sha256: committed.hash,
    file: committed.file,
    slot_bindings: frozen.plan.map((slot) => ({
      ...slot,
      question_id: publicBank.questions.filter((q) => q.role === slot.role)[
        slot.ordinal - 1
      ]?.id,
    })),
    expectations_released: false,
  }
  await writeArtifact(preparation, "registration.json", registration)
  await writeArtifact(frozenDir, "freeze.json", frozen)
  await writeArtifact(frozenDir, "release.json", released)
  await writeArtifact(frozenDir, "release-attempt.json", attempted)
  await writeArtifact(
    join(frozenDir, "receipts"),
    `${receipt.receipt_id}.json`,
    receipt
  )
  await writeArtifact(devDir, "manifest.json", development)
  await writeArtifact(devDir, "questions.json", bank)
  await writeArtifact(devDir, "review-input/synthetic-review.json", {})
  await writeArtifact(
    devDir,
    "development-reports/synthetic-review.json",
    review
  )
  await mkdir(join(repo.root, "packages/evals/results"), { recursive: true })
  state.root = repo.root
  state.current = manifestSchema.parse({
    ...development,
    versions: { ...development.versions, code_commit: committed.head },
  })
  state.runtime = runtime
  return {
    ...repo,
    ...committed,
    preparation,
    frozenDir,
    dir,
    released,
    frozen,
    runtime,
  }
}
beforeEach(() => {
  state.root = ""
  state.current = null
  state.calls = []
  state.observed = 0
  state.disposed = 0
  state.onAttempt = () => {}
  state.statusTarget = ""
  state.statusReplaced = false
  state.statusRawReads = 0
  state.statusFdReadCounters = []
  state.afterStatusRealpath = async () => {}
})
afterEach(async () => {
  state.root = ""
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

describe("released first-holdout executor with offline boundaries", () => {
  it("accepts only one clean question-only child and rejects unrelated commits even with unchanged executable source", async () => {
    const c = await repository(),
      published = await questionCommit(c.root)
    expect(
      verifyHoldoutQuestionCommit(
        c.root,
        c.base,
        published.file,
        published.hash
      )
    ).toBe(published.head)
    git(c.root, [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-qm",
      "synthetic extra commit",
    ])
    expect(() =>
      verifyHoldoutQuestionCommit(
        c.root,
        c.base,
        published.file,
        published.hash
      )
    ).toThrow(/exactly one question-only child/)
  })
  it("rejects a child that includes unrelated data, a dirty question, and a wrong hash", async () => {
    const c = await repository(),
      published = await questionCommit(c.root)
    expect(() =>
      verifyHoldoutQuestionCommit(
        c.root,
        c.base,
        published.file,
        "f".repeat(64)
      )
    ).toThrow(/hash differs/)
    await writeFile(
      join(c.root, "packages/evals/questions", published.file),
      "synthetic changed"
    )
    expect(() =>
      verifyHoldoutQuestionCommit(
        c.root,
        c.base,
        published.file,
        published.hash
      )
    ).toThrow(/clean frozen/)
    git(c.root, ["restore", `packages/evals/questions/${published.file}`])
    await writeFile(join(c.root, "README.md"), "synthetic unrelated data")
    git(c.root, ["add", "README.md"])
    git(c.root, [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--amend",
      "--no-edit",
      "-q",
    ])
    expect(() =>
      verifyHoldoutQuestionCommit(
        c.root,
        c.base,
        published.file,
        published.hash
      )
    ).toThrow(/exactly one question-only child/)
  })
  it("prepares only released slots offline and preserves their separate split", async () => {
    const c = await fixture()
    const manifest = await prepareHoldoutRound(
      c.preparation,
      c.frozenDir,
      c.dir
    )
    expect(manifest.split).toBe("holdout_first")
    expect(manifest.attempts).toHaveLength(12)
    expect(manifest.attempts.slice(0, 4).map((a) => a.variant)).toEqual([
      "baseline",
      "playbook",
      "playbook",
      "baseline",
    ])
    expect(manifest.holdout?.frozen_base_commit).toBe(c.base)
    expect(manifest.holdout?.question_commit).toBe(c.head)
    expect(state.observed).toBe(0)
    expect(state.calls).toHaveLength(0)
    expect((await loadRoundSnapshot(c.dir)).manifest.split).toBe(
      "holdout_first"
    )
    await expect(prepareReview(c.dir, "too-early")).rejects.toThrow(/ENOENT/)
    await expect(recomputeReport(c.dir, "too-early")).rejects.toThrow(/ENOENT/)
    await expect(
      prepareHoldoutRound(c.preparation, c.frozenDir, c.dir)
    ).rejects.toThrow(/EEXIST/)
  })
  it("executes both variants with empty history, retains a provider failure and consumes the first round exactly once", async () => {
    const c = await fixture()
    await prepareHoldoutRound(c.preparation, c.frozenDir, c.dir)
    await executeHoldoutRound(c.dir, new AbortController().signal)
    expect(state.calls).toHaveLength(12)
    expect(state.calls.every((input) => input.history?.length === 0)).toBe(true)
    expect(
      state.calls.every(
        (input) =>
          Object.keys(input).toSorted().join(",") ===
          "history,question,role,scope,variant"
      )
    ).toBe(true)
    expect(state.calls.map((input) => input.variant).slice(0, 4)).toEqual([
      "baseline",
      "playbook",
      "playbook",
      "baseline",
    ])
    expect(state.disposed).toBe(1)
    const report = await recomputeReport(c.dir, "synthetic")
    expect(report.split).toBe("holdout_first")
    expect(report.attempts[1]?.status).toBe("error")
    expect(report.attempts[1]?.error_kind).toBe("investigation_failed")
    expect(report.acceptance).toBe("not_demonstrated")
    await expect(
      executeHoldoutRound(c.dir, new AbortController().signal)
    ).rejects.toThrow(/EEXIST/)
    expect(state.calls).toHaveLength(12)
    const marker = await readArtifact(
      c.frozenDir,
      "holdout-first-execution.json"
    )
    expect(marker).toHaveProperty("manifest_sha256")
    const prepared = await prepareReview(c.dir, "synthetic-review")
    expect(prepared.human_policy.selected_pair_ids).toHaveLength(3)
    const rated = await saveDevelopmentReport(c.dir, "synthetic-review", {
      judge_submissions: [],
      pair_judgments: [],
      human_reviews: [],
      s13_content: [],
      calibrations: [],
    })
    expect(rated.split).toBe("holdout_first")
    expect(rated.acceptance).toBe("not_demonstrated")
    expect(
      await readArtifact(c.dir, "holdout-reports/synthetic-review.json")
    ).toEqual(rated)
    await expect(
      readFile(join(c.dir, "development-reports/synthetic-review.json"))
    ).rejects.toThrow(/ENOENT/)
  })
  it("does not permit another output directory to reuse a consumed first round", async () => {
    const c = await fixture()
    await prepareHoldoutRound(c.preparation, c.frozenDir, c.dir)
    await executeHoldoutRound(c.dir, new AbortController().signal)
    const second = join(c.root, "packages/evals/results/second")
    await prepareHoldoutRound(c.preparation, c.frozenDir, second)
    await expect(
      executeHoldoutRound(second, new AbortController().signal)
    ).rejects.toThrow(/EEXIST/)
    expect(state.calls).toHaveLength(12)
  })
  it("rejects altered frozen source before observing runtime or calling a model", async () => {
    const c = await fixture()
    if (state.current === null) throw new Error("Missing fixture")
    state.current.versions.code_sha256 = "f".repeat(64)
    await expect(
      prepareHoldoutRound(c.preparation, c.frozenDir, c.dir)
    ).rejects.toThrow(/configuration or source changed/)
    expect(state.observed).toBe(0)
    expect(state.calls).toHaveLength(0)
  })
  it("rejects runtime identity drift before any attempt or consumption marker", async () => {
    const c = await fixture()
    await prepareHoldoutRound(c.preparation, c.frozenDir, c.dir)
    state.runtime.running_image_id = `sha256:${"f".repeat(64)}`
    await expect(
      executeHoldoutRound(c.dir, new AbortController().signal)
    ).rejects.toThrow(/Runtime changed/)
    expect(state.calls).toHaveLength(0)
    await expect(
      readFile(join(c.frozenDir, "holdout-first-execution.json"))
    ).rejects.toThrow(/ENOENT/)
  })
  it("stops on a mid-round source change without replacing earlier attempts", async () => {
    const c = await fixture()
    await prepareHoldoutRound(c.preparation, c.frozenDir, c.dir)
    state.onAttempt = () => {
      if (state.current !== null)
        state.current.versions.code_sha256 = "f".repeat(64)
    }
    await expect(
      executeHoldoutRound(c.dir, new AbortController().signal)
    ).rejects.toThrow(/configuration or source changed/)
    expect(state.calls).toHaveLength(1)
    const report = await recomputeReport(c.dir, "synthetic")
    expect(report.attempts.filter((a) => a.status === "missing")).toHaveLength(
      11
    )
    expect(state.disposed).toBe(1)
    await expect(
      executeHoldoutRound(c.dir, new AbortController().signal)
    ).rejects.toThrow(/configuration or source changed/)
  })
  it("reports a consumed round with unconfirmed completion using attempt metadata only and preserves every slot", async () => {
    const c = await fixture()
    const manifest = await prepareHoldoutRound(
      c.preparation,
      c.frozenDir,
      c.dir
    )
    const markerFile = join(c.frozenDir, "holdout-first-execution.json")
    await writeArtifact(c.frozenDir, "holdout-first-execution.json", {
      started_at: new Date().toISOString(),
      directory: c.dir,
      manifest_sha256: digest(manifest),
      runtime_sha256: digest(c.runtime),
    })
    const marker = await readFile(markerFile)
    for (const [index, plan] of manifest.attempts.slice(0, 3).entries())
      await writeArtifact(c.dir, `attempts/${plan.id}.json`, {
        schema_version: manifest.schema_version,
        plan,
        started_at: "2026-10-18T00:00:00.000Z",
        finished_at: "2026-10-18T00:00:00.010Z",
        elapsed_ms: 10,
        status: index === 0 ? "completed" : index === 1 ? "error" : "aborted",
        error_kind: index === 1 ? "investigation_failed" : null,
        record: { file: "runs/run_000000aa.json", sha256: "a".repeat(64) },
        receipts: [],
        missing_receipts: [],
      })
    await mkdir(join(c.dir, "runs"))
    await mkdir(join(c.dir, "private-review"))
    await writeFile(
      join(c.dir, "runs/run_000000aa.json"),
      "SYNTHETIC_FORBIDDEN_ANSWER"
    )
    await writeFile(
      join(c.dir, "private-review/synthetic.json"),
      "SYNTHETIC_FORBIDDEN_REVIEW"
    )
    const allowed = new Set([
      "manifest.json",
      "round-finished.json",
      ...manifest.attempts.map((plan) => `attempts/${plan.id}.json`),
    ])
    const originalRead = holdoutFiles.readHoldoutJson
    const reads = vi
      .spyOn(holdoutFiles, "readHoldoutJson")
      .mockImplementation((directory, file) => {
        if (directory !== c.dir || !allowed.has(file))
          throw new Error("SYNTHETIC_FORBIDDEN_CONTENT_ACCESS")
        return originalRead(directory, file)
      })
    try {
      const status = await readHoldoutStatus(c.dir)
      expect(status.completion).toBe("unconfirmed")
      expect(status.process_liveness).toBe("not_checked")
      expect(status.acceptance).toBe("not_demonstrated")
      expect(status.totals).toEqual({
        planned: 12,
        recorded: 3,
        completed: 1,
        failed: 1,
        aborted: 1,
        missing: 9,
        invalid: 0,
      })
      expect(
        status.attempts.map((attempt) => attempt.status).slice(0, 4)
      ).toEqual(["completed", "error", "aborted", "missing"])
      expect(reads.mock.calls).toHaveLength(14)
      expect(
        reads.mock.calls.every(
          ([directory, file]) => directory === c.dir && allowed.has(file)
        )
      ).toBe(true)
      expect(JSON.stringify(status)).not.toContain("SYNTHETIC_FORBIDDEN")
    } finally {
      reads.mockRestore()
    }
    expect(await readFile(markerFile)).toEqual(marker)
    await expect(readFile(join(c.dir, "round-finished.json"))).rejects.toThrow(
      /ENOENT/
    )
    await expect(recomputeReport(c.dir, "still-locked")).rejects.toThrow(
      /ENOENT/
    )
    await expect(prepareReview(c.dir, "still-locked")).rejects.toThrow(/ENOENT/)
    await expect(
      executeHoldoutRound(c.dir, new AbortController().signal)
    ).rejects.toThrow(/EEXIST/)
    expect(state.calls).toHaveLength(0)
    expect(await readFile(markerFile)).toEqual(marker)
  })
  it("never follows status metadata links into answers or reviewer content", async () => {
    const c = await fixture()
    const manifest = await prepareHoldoutRound(
      c.preparation,
      c.frozenDir,
      c.dir
    )
    await mkdir(join(c.dir, "attempts"))
    await mkdir(join(c.dir, "runs"))
    const forbidden = join(c.dir, "runs/run_000000aa.json")
    await writeFile(forbidden, "SYNTHETIC_FORBIDDEN_ANSWER")
    const first = manifest.attempts[0]
    if (first === undefined) throw new Error("Missing synthetic slot")
    await symlink(forbidden, join(c.dir, `attempts/${first.id}.json`))
    await symlink(forbidden, join(c.dir, "round-finished.json"))
    const originalRead = holdoutFiles.readHoldoutJson
    const reads = vi
      .spyOn(holdoutFiles, "readHoldoutJson")
      .mockImplementation((directory, file) => {
        if (
          directory !== c.dir ||
          (file !== "manifest.json" &&
            file !== "round-finished.json" &&
            !manifest.attempts.some(
              (plan) => file === `attempts/${plan.id}.json`
            ))
        )
          throw new Error("SYNTHETIC_FORBIDDEN_CONTENT_ACCESS")
        return originalRead(directory, file)
      })
    try {
      const status = await readHoldoutStatus(c.dir)
      expect(status.completion).toBe("invalid")
      expect(status.acceptance).toBe("not_demonstrated")
      expect(status.totals.invalid).toBe(1)
      expect(status.totals.missing).toBe(11)
      expect(reads.mock.calls).toHaveLength(14)
      expect(JSON.stringify(status)).not.toContain("SYNTHETIC_FORBIDDEN")
    } finally {
      reads.mockRestore()
    }
  })
  it.each(["symlink", "replacement"] as const)(
    "rejects a metadata %s exchanged after path validation without reading its answer bytes",
    async (kind) => {
      const c = await fixture()
      const manifest = await prepareHoldoutRound(
        c.preparation,
        c.frozenDir,
        c.dir
      )
      const first = manifest.attempts[0]
      if (first === undefined) throw new Error("Missing synthetic slot")
      await mkdir(join(c.dir, "attempts"))
      await mkdir(join(c.dir, "runs"))
      const target = join(c.dir, `attempts/${first.id}.json`)
      const forbidden = join(c.dir, "runs/run_000000aa.json")
      await writeArtifact(c.dir, `attempts/${first.id}.json`, {
        schema_version: manifest.schema_version,
        plan: first,
        started_at: "2026-10-18T00:00:00.000Z",
        finished_at: "2026-10-18T00:00:00.010Z",
        elapsed_ms: 10,
        status: "error",
        error_kind: "synthetic",
        record: null,
        receipts: [],
        missing_receipts: [],
      })
      await writeFile(
        forbidden,
        JSON.stringify({ private_answer: "SYNTHETIC_FORBIDDEN_ANSWER" })
      )
      state.statusTarget = target
      let checkedTarget = false
      state.afterStatusRealpath = async (path) => {
        if (path === target) checkedTarget = true
        else if (path === c.dir && checkedTarget && !state.statusReplaced) {
          await rename(target, `${target}.original`)
          if (kind === "symlink") await symlink(forbidden, target)
          else await copyFile(forbidden, target)
          state.statusReplaced = true
        }
      }
      const status = await readHoldoutStatus(c.dir)
      expect(state.statusReplaced).toBe(true)
      expect(state.statusRawReads).toBe(0)
      expect(
        state.statusFdReadCounters.reduce((sum, count) => sum + count(), 0)
      ).toBe(0)
      expect(status.totals.invalid).toBe(1)
      expect(status.completion).toBe("unconfirmed")
      expect(status.acceptance).toBe("not_demonstrated")
      expect(JSON.stringify(status)).not.toContain("SYNTHETIC_FORBIDDEN")
    }
  )
  it("rejects unknown reviewer fields in the only question input path", () => {
    expect(
      holdoutQuestionBankSchema.safeParse({
        ...publicBank,
        expectations: { private: "SYNTHETIC_PRIVATE_SENTINEL" },
      }).success
    ).toBe(false)
  })
})
