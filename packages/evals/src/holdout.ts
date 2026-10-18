import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path"
import { z } from "zod"
import { parse, stringify } from "yaml"
import { investigationScopeSchema } from "@workspace/agent/ai-sdk"
import { findWorkspaceRoot } from "@workspace/analytics/config"
import { digest, writeArtifact } from "./artifacts.ts"
import { receiptSchema } from "@workspace/domain/receipt"
import { answerRoleSchema } from "@workspace/domain/answer"
import { attemptSchema, manifestSchema } from "./contracts.ts"
import { recomputeDevelopmentReport } from "./development.ts"
import { loadRoundSnapshot } from "./report.ts"
import { createManifest } from "./runner.ts"
import {
  corpusRuntimeSummarySchema,
  observeEvalRuntime,
  runtimeSchema,
} from "./holdout-runtime.ts"

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const role = answerRoleSchema
const roles = role.options
const date = z.iso.datetime()
const rawHash = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex")

/** The only information the implementation sees before a valid freeze. */
export const holdoutMetadataSchema = z.strictObject({
  schema_version: z.literal(1),
  set_id: id,
  created_at: date,
  author_id: id,
  author_not_playbook_author: z.literal(true),
  sealed: z.literal(true),
  contaminated: z.literal(false),
  role_counts: z.strictObject({
    engineer: z.number().int().min(2).max(100),
    team_lead: z.number().int().min(2).max(100),
    manager: z.number().int().min(2).max(100),
  }),
  datasets: z.tuple([z.literal("bgl"), z.literal("openstack")]),
  data_version: z.string().regex(/^dv_[a-zA-Z0-9]+$/),
  files: z.strictObject({
    questions_sha256: hash,
    expectations_sha256: hash,
    evidence_sha256: hash,
  }),
})
const holdoutQuestionSchema = z.strictObject({
  id,
  role,
  question: z.string().min(1).max(4000),
  scope: investigationScopeSchema.refine((scope) => {
    const datasets = Array.isArray(scope.dataset)
      ? scope.dataset
      : [scope.dataset]
    return datasets.every((dataset) =>
      ["bgl", "openstack"].includes(dataset ?? "")
    )
  }, "An explicit base-corpus dataset is required"),
})
export const holdoutQuestionBankSchema = z
  .strictObject({
    schema_version: z.literal(1),
    set_id: id,
    questions: z.array(holdoutQuestionSchema).min(6).max(300),
  })
  .refine(
    (bank) =>
      new Set(bank.questions.map((question) => question.id)).size ===
      bank.questions.length,
    "Question IDs must be unique"
  )

/** Parse first and select only agent input. Reviewer material has no route here. */
export function holdoutInvestigationInput(value: unknown) {
  const question = checked(holdoutQuestionSchema, value)
  return {
    question: question.question,
    role: question.role,
    scope: question.scope,
  }
}

const registrationSchema = z.strictObject({
  schema_version: z.literal(1),
  registered_at: date,
  metadata_sha256: hash,
  metadata: holdoutMetadataSchema,
})
const slotSchema = z.strictObject({
  slot: id,
  role,
  ordinal: z.number().int().positive(),
  variant: z.enum(["baseline", "playbook"]),
  repetition: z.literal(1),
  order: z.number().int().nonnegative(),
})
const freezeSchema = z.strictObject({
  schema_version: z.literal(1),
  state: z.literal("frozen_before_release"),
  frozen_at: date,
  metadata_sha256: hash,
  preparation_sha256: hash,
  development: z.strictObject({
    directory: z.string().min(1),
    reviewer_version: id,
    manifest_sha256: hash,
    report_sha256: hash,
    review_input_sha256: hash,
  }),
  configuration: manifestSchema,
  lockfile_sha256: hash,
  runtime: runtimeSchema,
  plan: z.array(slotSchema).min(12),
  repeat_anchors: z.strictObject({
    split: z.literal("development"),
    question_ids: z.array(id).length(3),
    trials_per_variant: z.literal(3),
    holdout_trials_per_variant: z.literal(1),
  }),
  policy: z.strictObject({
    version: z.literal("log54-v1"),
    comparison: z.literal("blind_both_orders"),
    human_sample: z.literal("one_pair_per_role_and_all_critical_findings"),
    error_policy: z.literal("retain_all_no_replacement_or_resume"),
    acceptance: z.literal("unchanged_technical_13_1_per_split"),
    inspection: z.literal("questions_become_regression_after_inspection"),
  }),
  limitations: z.array(z.string()),
})
export const holdoutReleaseAttemptSchema = z.strictObject({
  schema_version: z.literal(1),
  state: z.literal("release_attempted"),
  attempted_at: date,
  set_id: id,
  freeze_sha256: hash,
  sealed_questions_sha256: hash,
  retry_policy: z.literal("fresh_set_required_after_any_attempt"),
  expectations_released: z.literal(false),
})
export const holdoutReleaseSchema = z.strictObject({
  schema_version: z.literal(1),
  state: z.literal("released_known_questions"),
  released_at: date,
  set_id: id,
  freeze_sha256: hash,
  release_attempt_sha256: hash,
  sealed_questions_sha256: hash,
  public_questions_sha256: hash,
  file: z.string().regex(/^holdout-[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.yaml$/),
  slot_bindings: z.array(slotSchema.extend({ question_id: id })).min(12),
  expectations_released: z.literal(false),
})

function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error("Invalid holdout artifact")
  return result.data
}

/** Reject links and bound reads, including links in the selected directory. */
async function readFileBounded(dir: string, file: string): Promise<Buffer> {
  const maximum = 4_194_304
  const directory = await lstat(dir)
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("Holdout artifact directory must not be a link")
  const target = join(dir, file)
  const info = await lstat(target)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum)
    throw new Error("Invalid holdout artifact file")
  if ((await realpath(target)) !== join(await realpath(dir), file))
    throw new Error("Holdout artifact path leaves its directory")
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.ino !== info.ino ||
      opened.dev !== info.dev ||
      opened.size > maximum
    )
      throw new Error("Holdout artifact changed while opening")
    const bytes = Buffer.alloc(maximum + 1)
    let size = 0
    while (size < bytes.length) {
      const part = await handle.read(bytes, size, bytes.length - size, null)
      if (part.bytesRead === 0) break
      size += part.bytesRead
    }
    if (size > maximum)
      throw new Error("Holdout artifact file exceeds its limit")
    return bytes.subarray(0, size)
  } finally {
    await handle.close()
  }
}

async function readJson(dir: string, file: string): Promise<unknown> {
  const raw = await readFileBounded(dir, file)
  try {
    return JSON.parse(raw.toString("utf8"))
  } catch {
    throw new Error("Invalid holdout JSON artifact")
  }
}

async function registration(dir: string) {
  const value = checked(
    registrationSchema,
    await readJson(dir, "registration.json")
  )
  if (
    digest(value.metadata) !== value.metadata_sha256 ||
    Date.parse(value.registered_at) < Date.parse(value.metadata.created_at)
  )
    throw new Error("Holdout metadata binding differs")
  return value
}

async function checkRuntimeReceipt(
  directory: string,
  runtime: z.infer<typeof runtimeSchema>
) {
  const receipt = checked(
    receiptSchema,
    await readJson(directory, `${runtime.corpus_receipt_id}.json`)
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
    await readJson(dirname(metadataPath), basename(metadataPath))
  )
  if (Date.parse(metadata.created_at) > Date.now())
    throw new Error("Holdout creation time is in the future")
  const result = registrationSchema.parse({
    schema_version: 1,
    registered_at: new Date().toISOString(),
    metadata_sha256: digest(metadata),
    metadata,
  })
  await mkdir(newPreparationDirectory, { recursive: false })
  await writeArtifact(newPreparationDirectory, "registration.json", result)
  return result
}

function holdoutPlan(metadata: z.infer<typeof holdoutMetadataSchema>) {
  const plan: z.infer<typeof slotSchema>[] = []
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
    await readJson(dir, "execution.json")
  )
  if (
    execution.manifest_sha256 !== digest(manifest) ||
    Date.parse(execution.started_at) < Date.parse(manifest.created_at)
  )
    throw new Error("Development execution binding differs")
  const runtime = checked(runtimeSchema, await readJson(dir, "runtime.json"))
  if (
    digest(runtime) !== execution.runtime_sha256 ||
    runtime.data_version !== manifest.versions.data_version ||
    Date.parse(runtime.observed_at) > Date.parse(execution.started_at)
  )
    throw new Error("Development runtime observation differs")
  const reviewInput = await readJson(dir, `review-input/${reviewer}.json`)
  const report = await recomputeDevelopmentReport(dir, reviewer, reviewInput)
  if (
    report.acceptance !== "passed" ||
    !report.core.measurement_complete ||
    report.core.attempts.some((attempt) => attempt.status !== "completed")
  )
    throw new Error("Development acceptance has not passed")
  await checkRuntimeReceipt(join(dir, "runtime-receipts"), runtime)
  if (
    digest(await readJson(dir, `development-reports/${reviewer}.json`)) !==
    digest(report)
  )
    throw new Error("Saved development report differs from replay")
  for (const planned of manifest.attempts) {
    const attempt = checked(
      attemptSchema,
      await readJson(dir, `attempts/${planned.id}.json`)
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
  const prepared = await registration(preparationDirectory)
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
  const result = freezeSchema.parse({
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
  const prepared = await registration(preparationDirectory)
  const frozen = checked(
    freezeSchema,
    await readJson(freezeDirectory, "freeze.json")
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
  const raw = await readFileBounded(vaultDirectory, "questions.yaml")
  if (rawHash(raw) !== prepared.metadata.files.questions_sha256)
    throw new Error("Sealed question file hash differs")
  for (const [file, expected] of [
    ["expectations.json", prepared.metadata.files.expectations_sha256],
    ["evidence.json", prepared.metadata.files.evidence_sha256],
  ]) {
    if (rawHash(await readFileBounded(vaultDirectory, file ?? "")) !== expected)
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
    rawHash(await readFileBounded(targetQuestionsDirectory, file)) !==
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
    slot_bindings: frozen.plan.map((slot) => ({
      ...slot,
      question_id: bank.questions.filter(
        (question) => question.role === slot.role
      )[slot.ordinal - 1]?.id,
    })),
    expectations_released: false,
  })
  await writeArtifact(freezeDirectory, "release.json", released)
  return released
}
