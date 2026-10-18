import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path"
import { readHoldoutFile, readHoldoutJson } from "./holdout-files.ts"
import { z } from "zod"
import { parse, stringify } from "yaml"
import { findWorkspaceRoot } from "@workspace/analytics/config"
import { digest, writeArtifact } from "./artifacts.ts"
import { receiptSchema } from "@workspace/domain/receipt"
import { answerRoleSchema } from "@workspace/domain/answer"
import { attemptSchema } from "./contracts.ts"
import { recomputeDevelopmentReport } from "./development.ts"
import { loadRoundSnapshot } from "./report.ts"
import { createManifest } from "./runner.ts"
import {
  corpusRuntimeSummarySchema,
  observeEvalRuntime,
  runtimeSchema,
} from "./holdout-runtime.ts"

import {
  holdoutQuestionBankSchema,
  holdoutInvestigationInput,
  bindHoldoutSlots,
} from "./holdout-questions.ts"
export {
  holdoutQuestionBankSchema,
  holdoutInvestigationInput,
} from "./holdout-questions.ts"

import {
  holdoutMetadataSchema,
  holdoutRegistrationSchema,
  holdoutFreezeSchema,
  holdoutReleaseAttemptSchema,
  holdoutReleaseSchema,
} from "./holdout-artifacts.ts"
export {
  holdoutMetadataSchema,
  holdoutReleaseAttemptSchema,
  holdoutReleaseSchema,
} from "./holdout-artifacts.ts"
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const date = z.iso.datetime()
const roles = answerRoleSchema.options
const rawHash = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex")

function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error("Invalid holdout artifact")
  return result.data
}

export async function loadHoldoutRegistration(dir: string) {
  const value = checked(
    holdoutRegistrationSchema,
    await readHoldoutJson(dir, "registration.json")
  )
  if (
    digest(value.metadata) !== value.metadata_sha256 ||
    Date.parse(value.registered_at) < Date.parse(value.metadata.created_at)
  )
    throw new Error("Holdout metadata binding differs")
  return value
}

export async function checkRuntimeReceipt(
  directory: string,
  runtime: z.infer<typeof runtimeSchema>
) {
  const receipt = checked(
    receiptSchema,
    await readHoldoutJson(directory, `${runtime.corpus_receipt_id}.json`)
  )
  if (
    digest(receipt) !== runtime.corpus_receipt_sha256 ||
    receipt.tool !== "describe_corpus" ||
    receipt.client !== "eval" ||
    receipt.data_version !== runtime.data_version ||
    digest(receipt.result) !== receipt.result_digest ||
    Date.parse(receipt.created_at) > Date.parse(runtime.observed_at)
  )
    throw new Error("Runtime corpus receipt binding differs")
  const content = checked(corpusRuntimeSummarySchema, receipt.result)
  if (
    content.versions.data_version !== runtime.data_version ||
    content.datasets
      .map((dataset) => dataset.dataset)
      .toSorted()
      .join(",") !== runtime.datasets.join(",")
  )
    throw new Error("Runtime corpus receipt scope differs")
}

/** Registration is metadata only and intentionally does not accept a vault. */
export async function registerHoldout(
  metadataPath: string,
  newPreparationDirectory: string
) {
  const metadata = checked(
    holdoutMetadataSchema,
    await readHoldoutJson(dirname(metadataPath), basename(metadataPath))
  )
  if (Date.parse(metadata.created_at) > Date.now())
    throw new Error("Holdout creation time is in the future")
  const result = holdoutRegistrationSchema.parse({
    schema_version: 1,
    registered_at: new Date().toISOString(),
    metadata_sha256: digest(metadata),
    metadata,
  })
  await mkdir(newPreparationDirectory, { recursive: false })
  await writeArtifact(newPreparationDirectory, "registration.json", result)
  return result
}

export function holdoutPlan(metadata: z.infer<typeof holdoutMetadataSchema>) {
  const plan: z.infer<typeof holdoutFreezeSchema>["plan"] = []
  let pair = 0
  for (const requestedRole of roles)
    for (
      let ordinal = 1;
      ordinal <= metadata.role_counts[requestedRole];
      ordinal += 1
    ) {
      const variants =
        pair % 2 === 0
          ? (["baseline", "playbook"] as const)
          : (["playbook", "baseline"] as const)
      for (const variant of variants)
        plan.push({
          slot: `${requestedRole}-${ordinal}`,
          role: requestedRole,
          ordinal,
          variant,
          repetition: 1,
          order: plan.length,
        })
      pair += 1
    }
  return plan
}

async function acceptedDevelopment(dir: string, reviewerInput: string) {
  const reviewer = checked(id, reviewerInput)
  const { manifest, bank } = await loadRoundSnapshot(dir)
  if (
    manifest.fixture_only ||
    manifest.split !== "development" ||
    manifest.experiment === undefined
  )
    throw new Error("A real LOG-53 development round is required")
  const execution = checked(
    z.strictObject({
      started_at: date,
      manifest_sha256: hash,
      runtime_sha256: hash,
    }),
    await readHoldoutJson(dir, "execution.json")
  )
  if (
    execution.manifest_sha256 !== digest(manifest) ||
    Date.parse(execution.started_at) < Date.parse(manifest.created_at)
  )
    throw new Error("Development execution binding differs")
  const runtime = checked(
    runtimeSchema,
    await readHoldoutJson(dir, "runtime.json")
  )
  if (
    digest(runtime) !== execution.runtime_sha256 ||
    runtime.data_version !== manifest.versions.data_version ||
    Date.parse(runtime.observed_at) > Date.parse(execution.started_at)
  )
    throw new Error("Development runtime observation differs")
  const reviewInput = await readHoldoutJson(
    dir,
    `review-input/${reviewer}.json`
  )
  const report = await recomputeDevelopmentReport(dir, reviewer, reviewInput)
  if (
    report.acceptance !== "passed" ||
    !report.core.measurement_complete ||
    report.core.attempts.some((attempt) => attempt.status !== "completed")
  )
    throw new Error("Development acceptance has not passed")
  await checkRuntimeReceipt(join(dir, "runtime-receipts"), runtime)
  if (
    digest(
      await readHoldoutJson(dir, `development-reports/${reviewer}.json`)
    ) !== digest(report)
  )
    throw new Error("Saved development report differs from replay")
  for (const planned of manifest.attempts) {
    const attempt = checked(
      attemptSchema,
      await readHoldoutJson(dir, `attempts/${planned.id}.json`)
    )
    if (
      digest(attempt.plan) !== digest(planned) ||
      attempt.status !== "completed" ||
      Date.parse(attempt.started_at) < Date.parse(execution.started_at) ||
      Date.parse(attempt.finished_at) < Date.parse(attempt.started_at) ||
      Date.parse(attempt.finished_at) > Date.now()
    )
      throw new Error("Development attempt chronology differs")
  }
  const current = await createManifest({
    root: findWorkspaceRoot(),
    round_id: manifest.round_id,
    bank,
    data_version: manifest.versions.data_version,
    repeated: manifest.repeated_questions,
    experiment: true,
  })
  const { created_at: priorTime, ...prior } = manifest
  const { created_at: currentTime, ...snapshot } = current
  void priorTime
  void currentTime
  if (current.versions.code_dirty || digest(prior) !== digest(snapshot))
    throw new Error("Development configuration changed or source is dirty")
  return { manifest, report, reviewInput, runtime }
}

/** Freeze fails before any vault access unless independent development passed. */
export async function freezeHoldout(
  preparationDirectory: string,
  developmentDirectory: string,
  reviewerVersion: string,
  newFreezeDirectory: string
) {
  const prepared = await loadHoldoutRegistration(preparationDirectory)
  const development = await acceptedDevelopment(
    developmentDirectory,
    reviewerVersion
  )
  if (
    prepared.metadata.data_version !==
    development.manifest.versions.data_version
  )
    throw new Error("Holdout and development data versions differ")
  const now = new Date().toISOString()
  if (Date.parse(prepared.registered_at) > Date.parse(now))
    throw new Error("Holdout registration occurs after freeze")
  await mkdir(newFreezeDirectory, { recursive: false })
  const runtime = await observeEvalRuntime(join(newFreezeDirectory, "receipts"))
  if (
    runtime.data_version !== prepared.metadata.data_version ||
    runtime.configured_image !== development.runtime.configured_image ||
    runtime.running_image_id !== development.runtime.running_image_id ||
    runtime.published_port !== development.runtime.published_port ||
    runtime.lockfile_sha256 !== development.runtime.lockfile_sha256
  )
    throw new Error("Current database differs from development and holdout")
  const result = holdoutFreezeSchema.parse({
    schema_version: 1,
    state: "frozen_before_release",
    frozen_at: new Date().toISOString(),
    metadata_sha256: prepared.metadata_sha256,
    preparation_sha256: digest(prepared),
    development: {
      directory: resolve(developmentDirectory),
      reviewer_version: reviewerVersion,
      manifest_sha256: digest(development.manifest),
      report_sha256: digest(development.report),
      review_input_sha256: digest(development.reviewInput),
    },
    configuration: development.manifest,
    lockfile_sha256: rawHash(
      await readFile(join(findWorkspaceRoot(), "pnpm-lock.yaml"))
    ),
    runtime,
    plan: holdoutPlan(prepared.metadata),
    repeat_anchors: {
      split: "development",
      question_ids: development.manifest.repeated_questions,
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
    limitations: [
      "No holdout question has been read or run by this operation.",
      "The three per-role repeat anchors belong to the already completed development round; each holdout slot is planned once per variant.",
      "The same image and corpus are observed before development execution and at freeze; this is configuration provenance, not holdout acceptance.",
      "Independent authorship and no prior inspection are author declarations; hashes bind content, not human knowledge.",
    ],
  })
  await writeArtifact(newFreezeDirectory, "freeze.json", result)
  return result
}

function inside(parent: string, child: string) {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

/** Release is a separate operation; expectations and evidence stay in the vault. */
export async function releaseHoldout(
  preparationDirectory: string,
  freezeDirectory: string,
  vaultDirectory: string,
  targetQuestionsDirectory: string
) {
  const prepared = await loadHoldoutRegistration(preparationDirectory)
  const frozen = checked(
    holdoutFreezeSchema,
    await readHoldoutJson(freezeDirectory, "freeze.json")
  )
  if (
    frozen.preparation_sha256 !== digest(prepared) ||
    frozen.metadata_sha256 !== prepared.metadata_sha256 ||
    digest(frozen.plan) !== digest(holdoutPlan(prepared.metadata)) ||
    Date.parse(frozen.frozen_at) < Date.parse(prepared.registered_at) ||
    Date.parse(frozen.frozen_at) > Date.now()
  )
    throw new Error("Holdout freeze binding or chronology differs")
  const development = await acceptedDevelopment(
    frozen.development.directory,
    frozen.development.reviewer_version
  )
  await checkRuntimeReceipt(join(freezeDirectory, "receipts"), frozen.runtime)
  if (
    digest(development.manifest) !== frozen.development.manifest_sha256 ||
    digest(development.report) !== frozen.development.report_sha256 ||
    digest(development.reviewInput) !==
      frozen.development.review_input_sha256 ||
    digest(frozen.repeat_anchors.question_ids) !==
      digest(development.manifest.repeated_questions) ||
    digest(development.manifest) !== digest(frozen.configuration) ||
    rawHash(await readFile(join(findWorkspaceRoot(), "pnpm-lock.yaml"))) !==
      frozen.lockfile_sha256
  )
    throw new Error("Frozen development configuration changed")
  // All replay and current-runtime checks precede even resolving the private vault.
  const current = await observeEvalRuntime(
    join(freezeDirectory, "release-observation-receipts")
  )
  if (
    current.data_version !== frozen.runtime.data_version ||
    current.configured_image !== frozen.runtime.configured_image ||
    current.running_image_id !== frozen.runtime.running_image_id ||
    current.published_port !== frozen.runtime.published_port
  )
    throw new Error("Runtime changed after freeze")
  const vault = await realpath(vaultDirectory),
    root = await realpath(findWorkspaceRoot())
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: root,
    encoding: "utf8",
  }).trim()
  const repositoryRoot = dirname(resolve(root, common))
  if (inside(root, vault) || inside(repositoryRoot, vault))
    throw new Error(
      "The private holdout vault must remain outside the repository"
    )
  // Record inspection before reading private content. Any partial failure keeps
  // this append-only marker and requires a fresh set rather than another attempt.
  const attempted = holdoutReleaseAttemptSchema.parse({
    schema_version: 1,
    state: "release_attempted",
    attempted_at: new Date().toISOString(),
    set_id: prepared.metadata.set_id,
    freeze_sha256: digest(frozen),
    sealed_questions_sha256: prepared.metadata.files.questions_sha256,
    retry_policy: "fresh_set_required_after_any_attempt",
    expectations_released: false,
  })
  await writeArtifact(freezeDirectory, "release-attempt.json", attempted)
  const raw = await readHoldoutFile(vaultDirectory, "questions.yaml")
  if (rawHash(raw) !== prepared.metadata.files.questions_sha256)
    throw new Error("Sealed question file hash differs")
  for (const [file, expected] of [
    ["expectations.json", prepared.metadata.files.expectations_sha256],
    ["evidence.json", prepared.metadata.files.evidence_sha256],
  ]) {
    if (rawHash(await readHoldoutFile(vaultDirectory, file ?? "")) !== expected)
      throw new Error("Sealed reviewer evidence hash differs")
  }
  let bank: z.infer<typeof holdoutQuestionBankSchema>
  try {
    bank = checked(holdoutQuestionBankSchema, parse(raw.toString("utf8")))
  } catch {
    throw new Error("Invalid public holdout question bank")
  }
  if (
    bank.set_id !== prepared.metadata.set_id ||
    roles.some(
      (requestedRole) =>
        bank.questions.filter((question) => question.role === requestedRole)
          .length !== prepared.metadata.role_counts[requestedRole]
    )
  )
    throw new Error("Sealed question IDs or role counts differ")
  const datasets = [
    ...new Set(
      bank.questions.flatMap((question) =>
        Array.isArray(question.scope.dataset)
          ? question.scope.dataset
          : [question.scope.dataset]
      )
    ),
  ].toSorted()
  if (datasets.join(",") !== prepared.metadata.datasets.join(","))
    throw new Error("Sealed question dataset coverage differs")
  for (const question of bank.questions) holdoutInvestigationInput(question)
  // Serialize validated public fields afresh: comments, anchors and other YAML
  // syntax in sealed source bytes may contain private reviewer material.
  const publicBytes = Buffer.from(stringify(bank)),
    publicHash = rawHash(publicBytes),
    file = `holdout-${bank.set_id}.yaml`
  await mkdir(targetQuestionsDirectory, { recursive: true })
  if ((await lstat(targetQuestionsDirectory)).isSymbolicLink())
    throw new Error("Holdout target directory must not be a link")
  await writeFile(join(targetQuestionsDirectory, file), publicBytes, {
    flag: "wx",
  })
  if (
    rawHash(await readHoldoutFile(targetQuestionsDirectory, file)) !==
    publicHash
  )
    throw new Error("Published holdout question file hash differs")
  const released = holdoutReleaseSchema.parse({
    schema_version: 1,
    state: "released_known_questions",
    released_at: new Date().toISOString(),
    set_id: bank.set_id,
    freeze_sha256: digest(frozen),
    release_attempt_sha256: digest(attempted),
    sealed_questions_sha256: rawHash(raw),
    public_questions_sha256: publicHash,
    file,
    slot_bindings: bindHoldoutSlots(frozen.plan, bank),
    expectations_released: false,
  })
  await writeArtifact(freezeDirectory, "release.json", released)
  return released
}
