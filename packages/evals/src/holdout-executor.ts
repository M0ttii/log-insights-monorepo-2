import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parse } from "yaml"
import { readHoldoutFile, readHoldoutJson } from "./holdout-files.ts"
import { z } from "zod"
import { findWorkspaceRoot } from "@workspace/analytics/config"
import { answerRoleSchema } from "@workspace/domain/answer"
import { digest, readArtifact, writeArtifact } from "./artifacts.ts"
import { manifestSchema, type EvalManifest } from "./contracts.ts"
import { recomputeDevelopmentReport } from "./development.ts"
import { createManifest, executePreparedRound } from "./runner.ts"
import { loadRoundSnapshot } from "./report.ts"
import {
  checkRuntimeReceipt,
  holdoutPlan,
  loadHoldoutRegistration,
} from "./holdout.ts"
import {
  holdoutQuestionBankSchema,
  bindHoldoutSlots,
  projectHoldoutQuestions,
  releasedHoldoutPlan,
} from "./holdout-questions.ts"
import type { runtimeSchema } from "./holdout-runtime.ts"

import {
  holdoutFreezeSchema,
  holdoutReleaseAttemptSchema,
  holdoutReleaseSchema,
} from "./holdout-artifacts.ts"

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const provenanceSchema = z.strictObject({
  preparation_directory: z.string().min(1),
  freeze_directory: z.string().min(1),
  manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
})

/** The only permitted post-freeze commit adds exactly the released public YAML. */
export function verifyHoldoutQuestionCommit(
  root: string,
  baseCommit: string,
  file: string,
  publicHash: string
): string {
  if (
    !/^[a-f0-9]{40,64}$/.test(baseCommit) ||
    !/^holdout-[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.yaml$/.test(file) ||
    !/^[a-f0-9]{64}$/.test(publicHash)
  )
    throw new Error("Invalid frozen commit or public question binding")
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" })
  const head = git(["rev-parse", "HEAD"]).trim()
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"])
    .trim()
    .split(" ")
  const path = `packages/evals/questions/${file}`
  const delta = git([
    "diff-tree",
    "--no-commit-id",
    "--name-status",
    "-r",
    "-z",
    "HEAD",
  ])
    .split("\0")
    .filter(Boolean)
  if (
    parents.length !== 2 ||
    parents[1] !== baseCommit ||
    delta.length !== 2 ||
    delta[0] !== "A" ||
    delta[1] !== path
  )
    throw new Error(
      "Holdout execution requires exactly one question-only child commit of the frozen base"
    )
  const tree = git(["ls-tree", "HEAD", "--", path]).trim()
  if (!tree.startsWith("100644 blob "))
    throw new Error("Released questions must be a regular committed file")
  const blob = execFileSync("git", ["show", `HEAD:${path}`], {
    cwd: root,
    maxBuffer: 4_194_305,
  })
  if (sha(blob) !== publicHash)
    throw new Error("Committed public question hash differs from release")
  const dirty = git(["status", "--porcelain", "-z", "--untracked-files=all"])
    .split("\0")
    .filter(Boolean)
    .some((entry) => !entry.slice(3).startsWith("packages/evals/results/"))
  if (dirty)
    throw new Error(
      "Holdout execution requires a clean frozen source and question commit"
    )
  return head
}

async function releasedSnapshot(
  preparation: string,
  freeze: string,
  root: string
) {
  const prepared = await loadHoldoutRegistration(preparation)
  const frozen = holdoutFreezeSchema.parse(
    await readHoldoutJson(freeze, "freeze.json")
  )
  const released = holdoutReleaseSchema.parse(
    await readHoldoutJson(freeze, "release.json")
  )
  const attempted = holdoutReleaseAttemptSchema.parse(
    await readHoldoutJson(freeze, "release-attempt.json")
  )
  if (
    frozen.preparation_sha256 !== digest(prepared) ||
    frozen.metadata_sha256 !== prepared.metadata_sha256 ||
    released.freeze_sha256 !== digest(frozen) ||
    attempted.freeze_sha256 !== digest(frozen) ||
    released.release_attempt_sha256 !== digest(attempted) ||
    released.set_id !== prepared.metadata.set_id ||
    attempted.set_id !== released.set_id ||
    released.file !== `holdout-${released.set_id}.yaml` ||
    released.sealed_questions_sha256 !==
      prepared.metadata.files.questions_sha256 ||
    attempted.sealed_questions_sha256 !== released.sealed_questions_sha256 ||
    digest(frozen.plan) !== digest(holdoutPlan(prepared.metadata)) ||
    Date.parse(frozen.frozen_at) < Date.parse(prepared.registered_at) ||
    Date.parse(attempted.attempted_at) < Date.parse(frozen.frozen_at) ||
    Date.parse(released.released_at) < Date.parse(attempted.attempted_at) ||
    Date.parse(released.released_at) > Date.now()
  )
    throw new Error("Frozen release binding or chronology differs")
  const head = verifyHoldoutQuestionCommit(
    root,
    frozen.configuration.versions.code_commit,
    released.file,
    released.public_questions_sha256
  )
  const publicBytes = await readHoldoutFile(
    join(root, "packages/evals/questions"),
    released.file
  )
  if (sha(publicBytes) !== released.public_questions_sha256)
    throw new Error("Released public question file changed")
  const publicBank = holdoutQuestionBankSchema.parse(
    parse(publicBytes.toString("utf8"))
  )
  const plan = releasedHoldoutPlan(publicBank)
  const bindings = bindHoldoutSlots(frozen.plan, publicBank)
  if (
    publicBank.set_id !== released.set_id ||
    digest(bindings) !== digest(released.slot_bindings) ||
    plan.length !== frozen.plan.length ||
    answerRoleSchema.options.some(
      (role) =>
        publicBank.questions.filter((q) => q.role === role).length !==
        prepared.metadata.role_counts[role]
    )
  )
    throw new Error("Released slot bindings differ from frozen plan")
  const { manifest: development, bank: devBank } = await loadRoundSnapshot(
    frozen.development.directory
  )
  const input = await readHoldoutJson(
    frozen.development.directory,
    `review-input/${frozen.development.reviewer_version}.json`
  )
  const report = await recomputeDevelopmentReport(
    frozen.development.directory,
    frozen.development.reviewer_version,
    input
  )
  if (
    development.split !== "development" ||
    development.fixture_only ||
    development.versions.code_dirty ||
    report.acceptance !== "passed" ||
    !report.core.measurement_complete ||
    report.core.attempts.some((a) => a.status !== "completed") ||
    digest(development) !== digest(frozen.configuration) ||
    digest(development) !== frozen.development.manifest_sha256 ||
    digest(report) !== frozen.development.report_sha256 ||
    digest(input) !== frozen.development.review_input_sha256 ||
    digest(
      await readHoldoutJson(
        frozen.development.directory,
        `development-reports/${frozen.development.reviewer_version}.json`
      )
    ) !== digest(report)
  )
    throw new Error("Frozen development acceptance changed")
  await checkRuntimeReceipt(join(freeze, "receipts"), frozen.runtime)
  const current = await createManifest({
    root,
    round_id: development.round_id,
    bank: devBank,
    data_version: development.versions.data_version,
    repeated: development.repeated_questions,
    experiment: true,
  })
  const { created_at: oldTime, ...oldConfig } = development
  const { created_at: newTime, ...newConfig } = current
  void oldTime
  void newTime
  // Only this proven question-only child may normalize HEAD for comparison.
  if (
    current.versions.code_commit !== head ||
    current.versions.code_dirty ||
    digest({
      ...newConfig,
      versions: {
        ...current.versions,
        code_commit: development.versions.code_commit,
      },
    }) !== digest(oldConfig) ||
    sha(await readFile(join(root, "pnpm-lock.yaml"))) !==
      frozen.lockfile_sha256 ||
    frozen.runtime.data_version !== prepared.metadata.data_version
  )
    throw new Error("Frozen configuration or source changed after release")
  return {
    frozen,
    released,
    publicBank,
    head,
    bank: projectHoldoutQuestions(publicBank, prepared.metadata.data_version),
    plan,
  }
}

function roundManifest(
  snapshot: Awaited<ReturnType<typeof releasedSnapshot>>,
  roundId: string,
  createdAt: string
): EvalManifest {
  const { frozen, released, head, bank, plan } = snapshot
  const humanQuestions = answerRoleSchema.options.map(
    (role) => bank.questions.find((q) => q.role === role)?.id
  )
  return manifestSchema.parse({
    ...frozen.configuration,
    round_id: roundId,
    created_at: createdAt,
    split: "holdout_first",
    versions: {
      ...frozen.configuration.versions,
      code_commit: head,
      questions_sha256: digest(bank),
    },
    attempts: plan,
    repeated_questions: [],
    experiment: undefined,
    holdout: {
      set_id: released.set_id,
      frozen_base_commit: frozen.configuration.versions.code_commit,
      question_commit: head,
      freeze_sha256: digest(frozen),
      release_sha256: digest(released),
      public_questions_sha256: released.public_questions_sha256,
      file: released.file,
      human_question_ids: humanQuestions,
      judge_max_bytes: frozen.configuration.experiment?.judge_max_bytes,
    },
  })
}

/** Offline, released public input only. Never opens the sealed vault or a provider. */
export async function prepareHoldoutRound(
  preparation: string,
  freeze: string,
  dir: string
) {
  const snapshot = await releasedSnapshot(
    preparation,
    freeze,
    findWorkspaceRoot()
  )
  const manifest = roundManifest(
    snapshot,
    dir.split("/").filter(Boolean).at(-1) ?? "holdout",
    new Date().toISOString()
  )
  await mkdir(dir, { recursive: false })
  await writeArtifact(dir, "manifest.json", manifest)
  await writeArtifact(dir, "questions.json", snapshot.bank)
  await writeArtifact(dir, "holdout-freeze.json", snapshot.frozen)
  await writeArtifact(dir, "holdout-release.json", snapshot.released)
  await writeArtifact(dir, "released-questions.json", snapshot.publicBank)
  await writeArtifact(
    dir,
    "holdout-provenance.json",
    provenanceSchema.parse({
      preparation_directory: resolve(preparation),
      freeze_directory: resolve(freeze),
      manifest_sha256: digest(manifest),
    })
  )
  return manifest
}

/** Explicit paid execution only after released provenance is revalidated. No resume. */
export async function executeHoldoutRound(dir: string, signal: AbortSignal) {
  const { manifest } = await loadRoundSnapshot(dir)
  const provenance = provenanceSchema.parse(
    await readArtifact(dir, "holdout-provenance.json")
  )
  if (
    manifest.split !== "holdout_first" ||
    manifest.holdout === undefined ||
    provenance.manifest_sha256 !== digest(manifest)
  )
    throw new Error("A prepared first-holdout round is required")
  const snapshot = await releasedSnapshot(
    provenance.preparation_directory,
    provenance.freeze_directory,
    findWorkspaceRoot()
  )
  const expected = roundManifest(
    snapshot,
    manifest.round_id,
    manifest.created_at
  )
  if (
    digest(expected) !== digest(manifest) ||
    digest(await readArtifact(dir, "questions.json")) !== digest(snapshot.bank)
  )
    throw new Error("Prepared holdout configuration changed")
  await executePreparedRound(dir, manifest, snapshot.bank, signal, {
    validateRuntime: async (runtime) => {
      sameRuntime(runtime, snapshot.frozen.runtime)
      await writeArtifact(
        provenance.freeze_directory,
        "holdout-first-execution.json",
        {
          started_at: new Date().toISOString(),
          directory: resolve(dir),
          manifest_sha256: digest(manifest),
          runtime_sha256: digest(runtime),
        }
      )
    },
    onFinish: async (completion) => {
      await writeArtifact(dir, "round-finished.json", {
        ...completion,
        finished_at: new Date().toISOString(),
        manifest_sha256: digest(manifest),
      })
    },
    beforeAttempt: async () => {
      const current = await releasedSnapshot(
        provenance.preparation_directory,
        provenance.freeze_directory,
        findWorkspaceRoot()
      )
      if (
        digest(
          roundManifest(current, manifest.round_id, manifest.created_at)
        ) !== digest(manifest)
      )
        throw new Error("Holdout configuration changed during the first round")
    },
  })
}

function sameRuntime(
  current: z.infer<typeof runtimeSchema>,
  frozen: z.infer<typeof runtimeSchema>
) {
  if (
    current.data_version !== frozen.data_version ||
    current.configured_image !== frozen.configured_image ||
    current.running_image_id !== frozen.running_image_id ||
    current.published_port !== frozen.published_port ||
    current.lockfile_sha256 !== frozen.lockfile_sha256 ||
    digest(current.datasets) !== digest(frozen.datasets)
  )
    throw new Error("Runtime changed after holdout freeze")
}
