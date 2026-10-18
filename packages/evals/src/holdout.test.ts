import { createHash } from "node:crypto"
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parse, stringify } from "yaml"
import { findWorkspaceRoot } from "@workspace/analytics/config"
import { digest, writeArtifact } from "./artifacts.ts"
import { loadQuestions, manifestSchema } from "./contracts.ts"
import { recomputeDevelopmentReport } from "./development.ts"
import { REPEATED_QUESTIONS } from "./experiment.ts"
import { observeEvalRuntime, runtimeSchema } from "./holdout-runtime.ts"
import { createManifest } from "./runner.ts"
import { sourceReceipt } from "./report-fixtures.ts"
import {
  freezeHoldout,
  holdoutInvestigationInput,
  holdoutMetadataSchema,
  holdoutQuestionBankSchema,
  holdoutReleaseAttemptSchema,
  holdoutReleaseSchema,
  registerHoldout,
  releaseHoldout,
} from "./holdout.ts"

// This suite tests the protocol around an independently passed development
// round. These mocked pass/runtime controls are never corpus or acceptance proof.
vi.mock("./development.ts", () => ({
  recomputeDevelopmentReport: vi.fn<typeof recomputeDevelopmentReport>(),
}))
vi.mock("./runner.ts", () => ({
  createManifest: vi.fn<typeof createManifest>(),
}))
vi.mock("./holdout-runtime.ts", async (original) => ({
  ...(await original<typeof import("./holdout-runtime.ts")>()),
  observeEvalRuntime: vi.fn<typeof observeEvalRuntime>(),
}))

const directories: string[] = []
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex")
const syntheticQuestions = {
  schema_version: 1,
  set_id: "synthetic-control",
  questions: (["engineer", "team_lead", "manager"] as const).flatMap((role) =>
    [1, 2].map((ordinal) => ({
      id: `synthetic-${role}-${ordinal}`,
      role,
      question: "Clearly synthetic lifecycle boundary control.",
      scope: { dataset: ordinal === 1 ? "bgl" : "openstack" },
    }))
  ),
}

async function controls(
  questionBank: unknown = syntheticQuestions,
  questionBytes?: string
) {
  const root = await mkdtemp(join(tmpdir(), "log54-protocol-"))
  directories.push(root)
  const development = join(root, "development")
  const preparation = join(root, "preparation")
  const frozen = join(root, "freeze")
  const vault = join(root, "vault")
  const target = join(root, "questions")
  const fs = await import("node:fs/promises")
  await fs.mkdir(development)
  await fs.mkdir(vault)
  const bank = await loadQuestions()
  const actualRunner =
    await vi.importActual<typeof import("./runner.ts")>("./runner.ts")
  const base = await actualRunner.createManifest({
    root: findWorkspaceRoot(),
    round_id: "synthetic-protocol-control",
    bank,
    data_version: "dv_syntheticControl",
    repeated: REPEATED_QUESTIONS,
    experiment: true,
  })
  const manifest = manifestSchema.parse({
    ...base,
    versions: { ...base.versions, code_dirty: false },
  })
  await writeArtifact(development, "manifest.json", manifest)
  await writeArtifact(development, "questions.json", bank)
  const observedAt = new Date().toISOString()
  const result = {
    datasets: [{ dataset: "bgl" }, { dataset: "openstack" }],
    versions: {
      data_version: manifest.versions.data_version,
      source: "corpus",
    },
  }
  const receipt = {
    ...sourceReceipt,
    receipt_id: "r_00000001",
    created_at: observedAt,
    tool: "describe_corpus",
    data_version: manifest.versions.data_version,
    result,
    result_digest: digest(result),
  }
  const runtime = runtimeSchema.parse({
    observed_at: observedAt,
    configured_image: "synthetic/26.10.1",
    running_image_id: `sha256:${"1".repeat(64)}`,
    published_port: 17954,
    corpus_receipt_id: "r_00000001",
    corpus_receipt_sha256: digest(receipt),
    data_version: manifest.versions.data_version,
    source: "corpus",
    datasets: ["bgl", "openstack"],
    lockfile_sha256: sha(
      await readFile(join(findWorkspaceRoot(), "pnpm-lock.yaml"))
    ),
  })
  await writeArtifact(
    join(development, "runtime-receipts"),
    "r_00000001.json",
    receipt
  )
  await writeArtifact(development, "runtime.json", runtime)
  await writeArtifact(development, "execution.json", {
    started_at: new Date().toISOString(),
    manifest_sha256: digest(manifest),
    runtime_sha256: digest(runtime),
  })
  for (const plan of manifest.attempts)
    await writeArtifact(development, `attempts/${plan.id}.json`, {
      schema_version: manifest.schema_version,
      plan,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      elapsed_ms: 0,
      status: "completed",
      error_kind: null,
      record: null,
      receipts: [],
      missing_receipts: [],
    })
  const actualDevelopment =
    await vi.importActual<typeof import("./development.ts")>("./development.ts")
  await actualDevelopment.prepareReview(development, "synthetic-review")
  const input = {
    judge_submissions: [],
    pair_judgments: [],
    human_reviews: [],
    s13_content: [],
  }
  const report = await actualDevelopment.recomputeDevelopmentReport(
    development,
    "synthetic-review",
    input
  )
  const passedControl = {
    ...report,
    acceptance: "passed" as const,
    core: {
      ...report.core,
      measurement_complete: true,
      attempts: report.core.attempts.map((attempt) => ({
        ...attempt,
        status: "completed" as const,
      })),
    },
  }
  vi.mocked(recomputeDevelopmentReport).mockResolvedValue(passedControl)
  vi.mocked(createManifest).mockResolvedValue(manifest)
  vi.mocked(observeEvalRuntime).mockImplementation(async (directory) => {
    await writeArtifact(directory, "r_00000001.json", receipt)
    return runtime
  })
  await writeArtifact(development, "review-input/synthetic-review.json", input)
  await writeArtifact(
    development,
    "development-reports/synthetic-review.json",
    passedControl
  )
  const raw = questionBytes ?? stringify(questionBank)
  const expectations = JSON.stringify({
    private_expected_answer: "SYNTHETIC_REVIEWER_SENTINEL",
  })
  const evidence = JSON.stringify({
    reviewer_only: "SYNTHETIC_EVIDENCE_SENTINEL",
  })
  await writeFile(join(vault, "questions.yaml"), raw)
  await writeFile(join(vault, "expectations.json"), expectations)
  await writeFile(join(vault, "evidence.json"), evidence)
  const metadata = holdoutMetadataSchema.parse({
    schema_version: 1,
    set_id: syntheticQuestions.set_id,
    created_at: "2026-01-01T00:00:00Z",
    author_id: "synthetic-independent-control",
    author_not_playbook_author: true,
    sealed: true,
    contaminated: false,
    role_counts: { engineer: 2, team_lead: 2, manager: 2 },
    datasets: ["bgl", "openstack"],
    data_version: "dv_syntheticControl",
    files: {
      questions_sha256: sha(raw),
      expectations_sha256: sha(expectations),
      evidence_sha256: sha(evidence),
    },
  })
  const metadataPath = join(root, "metadata.json")
  await writeFile(metadataPath, JSON.stringify(metadata))
  await registerHoldout(metadataPath, preparation)
  return {
    root,
    preparation,
    development,
    frozen,
    vault,
    target,
    metadata,
    manifest,
    passedControl,
    runtime,
  }
}

async function artifactText(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true })
  const texts = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? artifactText(join(directory, entry.name))
        : readFile(join(directory, entry.name), "utf8")
    )
  )
  return texts.join("\n")
}

afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

describe("sealed holdout lifecycle with synthetic gate controls", () => {
  it("predeclares every slot/variant and binds verified public bytes to the sealed source", async () => {
    const c = await controls()
    const frozen = await freezeHoldout(
      c.preparation,
      c.development,
      "synthetic-review",
      c.frozen
    )
    expect(frozen.plan).toHaveLength(12)
    expect(frozen.plan.slice(0, 4).map((slot) => slot.variant)).toEqual([
      "baseline",
      "playbook",
      "playbook",
      "baseline",
    ])
    expect(frozen.repeat_anchors).toEqual({
      split: "development",
      question_ids: REPEATED_QUESTIONS,
      trials_per_variant: 3,
      holdout_trials_per_variant: 1,
    })
    expect(JSON.stringify(frozen)).not.toContain("SYNTHETIC_REVIEWER_SENTINEL")
    const released = await releaseHoldout(
      c.preparation,
      c.frozen,
      c.vault,
      c.target
    )
    const publicBytes = await readFile(join(c.target, released.file))
    expect(parse(publicBytes.toString("utf8"))).toEqual(syntheticQuestions)
    expect(released.public_questions_sha256).toBe(sha(publicBytes))
    expect(released.sealed_questions_sha256).toBe(
      c.metadata.files.questions_sha256
    )
    const attempted = holdoutReleaseAttemptSchema.parse(
      JSON.parse(await readFile(join(c.frozen, "release-attempt.json"), "utf8"))
    )
    expect(released.release_attempt_sha256).toBe(digest(attempted))
    expect(Date.parse(released.released_at)).toBeGreaterThanOrEqual(
      Date.parse(attempted.attempted_at)
    )
    expect(
      holdoutReleaseSchema.parse(
        JSON.parse(await readFile(join(c.frozen, "release.json"), "utf8"))
      )
    ).toEqual(released)
    expect(
      await import("node:fs/promises").then((fs) => fs.readdir(c.target))
    ).toEqual([released.file])
    expect(JSON.stringify(released)).not.toContain(
      "SYNTHETIC_REVIEWER_SENTINEL"
    )
    expect(JSON.stringify(released)).not.toContain(
      "SYNTHETIC_EVIDENCE_SENTINEL"
    )
    await expect(
      releaseHoldout(c.preparation, c.frozen, c.vault, c.target)
    ).rejects.toThrow(/EEXIST/)
    await expect(
      freezeHoldout(c.preparation, c.development, "synthetic-review", c.frozen)
    ).rejects.toThrow(/EEXIST/)
  })

  it("strips private YAML comments and anchor names from every public artifact and model input", async () => {
    const sentinels = [
      "SYNTHETIC_PRIVATE_COMMENT_SENTINEL",
      "SYNTHETIC_PRIVATE_ANCHOR_SENTINEL",
    ]
    const raw = `# ${sentinels[0]}\n${stringify(syntheticQuestions).replace(
      "question: Clearly",
      `question: &${sentinels[1]} Clearly`
    )}`
    for (const sentinel of sentinels) expect(raw).toContain(sentinel)
    const c = await controls(syntheticQuestions, raw)
    await freezeHoldout(
      c.preparation,
      c.development,
      "synthetic-review",
      c.frozen
    )
    const released = await releaseHoldout(
      c.preparation,
      c.frozen,
      c.vault,
      c.target
    )
    const publicBytes = await readFile(join(c.target, released.file))
    const bank = holdoutQuestionBankSchema.parse(
      parse(publicBytes.toString("utf8"))
    )
    expect(bank).toEqual(syntheticQuestions)
    expect(released.sealed_questions_sha256).toBe(sha(raw))
    expect(released.public_questions_sha256).toBe(sha(publicBytes))
    expect(released.public_questions_sha256).not.toBe(
      released.sealed_questions_sha256
    )
    const publicArtifacts = [
      await artifactText(c.preparation),
      await artifactText(c.frozen),
      await artifactText(c.target),
      JSON.stringify(released),
      JSON.stringify(bank.questions.map(holdoutInvestigationInput)),
    ].join("\n")
    for (const sentinel of sentinels)
      expect(publicArtifacts).not.toContain(sentinel)
  })

  it("replays development instead of trusting an edited saved passed report", async () => {
    const c = await controls()
    vi.mocked(recomputeDevelopmentReport).mockResolvedValue({
      ...c.passedControl,
      acceptance: "not_demonstrated",
    })
    await expect(
      freezeHoldout(c.preparation, c.development, "synthetic-review", c.frozen)
    ).rejects.toThrow(/has not passed/)
    expect(observeEvalRuntime).not.toHaveBeenCalled()
    await expect(readFile(join(c.frozen, "freeze.json"))).rejects.toThrow(
      /ENOENT/
    )
  })

  it("rejects a forged or changed saved report even if replay passed", async () => {
    const c = await controls()
    await writeFile(
      join(c.development, "development-reports/synthetic-review.json"),
      JSON.stringify({ ...c.passedControl, version: "edited" })
    )
    await expect(
      freezeHoldout(c.preparation, c.development, "synthetic-review", c.frozen)
    ).rejects.toThrow(/differs from replay/)
    expect(observeEvalRuntime).not.toHaveBeenCalled()
  })

  it.each(["model", "source", "limits", "pricing", "tools"])(
    "blocks %s configuration drift before runtime or vault access",
    async (change) => {
      const c = await controls()
      const drift = manifestSchema.parse({
        ...c.manifest,
        ...(change === "model"
          ? { model: { ...c.manifest.model, effort: "medium" } }
          : {}),
        ...(change === "source"
          ? {
              versions: { ...c.manifest.versions, code_sha256: "3".repeat(64) },
            }
          : {}),
        ...(change === "limits"
          ? { limits: { ...c.manifest.limits, timeout_ms: 1 } }
          : {}),
        ...(change === "pricing" ? { pricing: null } : {}),
        ...(change === "tools" ? { tool_catalog: [] } : {}),
      })
      vi.mocked(createManifest).mockResolvedValue(drift)
      await expect(
        freezeHoldout(
          c.preparation,
          c.development,
          "synthetic-review",
          c.frozen
        )
      ).rejects.toThrow(/configuration changed/)
      expect(observeEvalRuntime).not.toHaveBeenCalled()
    }
  )

  it("blocks changed current runtime identity after a valid freeze", async () => {
    const c = await controls()
    await freezeHoldout(
      c.preparation,
      c.development,
      "synthetic-review",
      c.frozen
    )
    vi.mocked(observeEvalRuntime).mockResolvedValue({
      ...c.runtime,
      running_image_id: `sha256:${"4".repeat(64)}`,
    })
    await rm(c.vault, { recursive: true })
    await expect(
      releaseHoldout(c.preparation, c.frozen, c.vault, c.target)
    ).rejects.toThrow(/Runtime changed/)
  })

  it("rejects dirty current source and changed development provenance", async () => {
    const c = await controls()
    vi.mocked(createManifest).mockResolvedValue(
      manifestSchema.parse({
        ...c.manifest,
        versions: { ...c.manifest.versions, code_dirty: true },
      })
    )
    await expect(
      freezeHoldout(c.preparation, c.development, "synthetic-review", c.frozen)
    ).rejects.toThrow(/source is dirty/)
    vi.mocked(createManifest).mockResolvedValue(c.manifest)
    const receiptPath = join(c.development, "runtime-receipts/r_00000001.json")
    const value: unknown = JSON.parse(await readFile(receiptPath, "utf8"))
    await writeFile(receiptPath, JSON.stringify({ changed: value }))
    await expect(
      freezeHoldout(c.preparation, c.development, "synthetic-review", c.frozen)
    ).rejects.toThrow(/Invalid holdout artifact/)
    expect(observeEvalRuntime).not.toHaveBeenCalled()
  })

  it.each([
    { ...syntheticQuestions, set_id: "different-synthetic-set" },
    {
      ...syntheticQuestions,
      questions: [
        ...syntheticQuestions.questions,
        { ...syntheticQuestions.questions[0], id: "synthetic-extra-role" },
      ],
    },
  ])("rejects a sealed but inconsistent bank", async (bank) => {
    const c = await controls(bank)
    await freezeHoldout(
      c.preparation,
      c.development,
      "synthetic-review",
      c.frozen
    )
    await expect(
      releaseHoldout(c.preparation, c.frozen, c.vault, c.target)
    ).rejects.toThrow(/IDs or role counts differ/)
  })

  it("preserves an existing target and leaves only an attempted release that cannot resume", async () => {
    const c = await controls()
    await freezeHoldout(
      c.preparation,
      c.development,
      "synthetic-review",
      c.frozen
    )
    const fs = await import("node:fs/promises")
    await fs.mkdir(c.target)
    const target = join(c.target, "holdout-synthetic-control.yaml")
    await writeFile(target, "existing public data")
    await expect(
      releaseHoldout(c.preparation, c.frozen, c.vault, c.target)
    ).rejects.toThrow(/EEXIST/)
    expect(await readFile(target, "utf8")).toBe("existing public data")
    const attempted = holdoutReleaseAttemptSchema.parse(
      JSON.parse(await readFile(join(c.frozen, "release-attempt.json"), "utf8"))
    )
    expect(attempted.state).toBe("release_attempted")
    expect(attempted.retry_policy).toBe("fresh_set_required_after_any_attempt")
    await expect(readFile(join(c.frozen, "release.json"))).rejects.toThrow(
      /ENOENT/
    )
    await rm(target)
    await expect(
      releaseHoldout(c.preparation, c.frozen, c.vault, c.target)
    ).rejects.toThrow(/EEXIST/)
    await expect(readFile(target)).rejects.toThrow(/ENOENT/)
    expect(
      JSON.parse(await readFile(join(c.frozen, "release-attempt.json"), "utf8"))
    ).toEqual(attempted)
  })

  it("does not claim completion when the target directory cannot be created", async () => {
    const c = await controls()
    await freezeHoldout(
      c.preparation,
      c.development,
      "synthetic-review",
      c.frozen
    )
    await writeFile(c.target, "existing target path")
    await expect(
      releaseHoldout(c.preparation, c.frozen, c.vault, c.target)
    ).rejects.toThrow(/EEXIST/)
    expect(await readFile(c.target, "utf8")).toBe("existing target path")
    expect(
      holdoutReleaseAttemptSchema.parse(
        JSON.parse(
          await readFile(join(c.frozen, "release-attempt.json"), "utf8")
        )
      ).state
    ).toBe("release_attempted")
    await expect(readFile(join(c.frozen, "release.json"))).rejects.toThrow(
      /ENOENT/
    )
  })

  it.each(["questions.yaml", "expectations.json", "evidence.json"])(
    "rejects changed sealed %s without leaking its content",
    async (file) => {
      const c = await controls()
      await freezeHoldout(
        c.preparation,
        c.development,
        "synthetic-review",
        c.frozen
      )
      await writeFile(join(c.vault, file), "PRIVATE_SYNTHETIC_CHANGED_CONTENT")
      await expect(
        releaseHoldout(c.preparation, c.frozen, c.vault, c.target)
      ).rejects.toThrow(/hash differs/)
      await expect(readFile(join(c.frozen, "release.json"))).rejects.toThrow(
        /ENOENT/
      )
    }
  )

  it("rejects symlinked sealed questions", async () => {
    const c = await controls()
    await freezeHoldout(
      c.preparation,
      c.development,
      "synthetic-review",
      c.frozen
    )
    const fs = await import("node:fs/promises")
    await fs.rename(
      join(c.vault, "questions.yaml"),
      join(c.root, "symlink-control.yaml")
    )
    await symlink(
      join(c.root, "symlink-control.yaml"),
      join(c.vault, "questions.yaml")
    )
    await expect(
      releaseHoldout(c.preparation, c.frozen, c.vault, c.target)
    ).rejects.toThrow(/artifact file/)
  })

  it("rejects metadata expansion, contamination and undersized roles", async () => {
    const c = await controls()
    for (const extra of [
      { question: "SYNTHETIC_PRIVATE_QUESTION" },
      { contaminated: true },
      { sealed: false },
      { role_counts: { engineer: 1, team_lead: 2, manager: 2 } },
    ])
      expect(
        holdoutMetadataSchema.safeParse({ ...c.metadata, ...extra }).success
      ).toBe(false)
  })
})
