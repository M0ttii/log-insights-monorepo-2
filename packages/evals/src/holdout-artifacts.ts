import { z } from "zod"
import { answerRoleSchema } from "@workspace/domain/answer"
import { manifestSchema } from "./contracts.ts"
import { runtimeSchema } from "./holdout-runtime.ts"
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const role = answerRoleSchema
const date = z.iso.datetime()

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

export const holdoutRegistrationSchema = z.strictObject({
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
export const holdoutFreezeSchema = z.strictObject({
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
