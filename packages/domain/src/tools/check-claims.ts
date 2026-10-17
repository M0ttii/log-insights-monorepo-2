import { z } from "zod"

import { verificationLine, type ClaimCounts } from "../claims.ts"
import {
  formatFactValue,
  factValueSchema,
  type Fact,
  type FactSpec,
} from "../facts.ts"
import { receiptIdSchema } from "../ids.ts"
import { canonicalJson, scopeSchema } from "../receipt.ts"
import type { ToolResult } from "../tool.ts"

/**
 * Contract of check_claims (technical.md § 8.3, concept A-14, S-08): the
 * model submits every number it states with the fact ID it cites; the tool
 * resolves each ID through the receipt store and compares value, metric and
 * group (rules in ../claims.ts). MCP and web use this one tool.
 *
 * `fact` is a bounded string, not a pattern: a malformed ID is the
 * per-claim status `unknown_fact`, so one bad ID does not reject the whole
 * call before the handler runs. Only schema violations (more than 30
 * claims, a missing group) are `invalid_input`.
 */

export const CLAIMS_MAX = 30
const TEXT_MAX = 64
const GROUP_MAX_KEYS = 8

const MISSING_GROUP =
  "Required: the group the text attributes the number to; pass {} for ungrouped facts."

const groupValueSchema = z.union([z.string().max(200), z.number(), z.boolean()])

const claimGroupSchema = z
  .record(z.string().min(1).max(TEXT_MAX), groupValueSchema, {
    error: (issue) => (issue.input === undefined ? MISSING_GROUP : undefined),
  })
  .refine((group) => Object.keys(group).length <= GROUP_MAX_KEYS, {
    message: `At most ${GROUP_MAX_KEYS} group keys.`,
  })
  .describe(
    'Dimension values the text attributes the number to, e.g. {"dataset":"bgl","team":"Compute Platform"}; must equal the fact\'s group exactly (keys and values). Required: pass {} for ungrouped facts.'
  )

export const claimSchema = z.strictObject({
  fact: z
    .string()
    .min(1)
    .max(TEXT_MAX)
    .describe(
      "Fact ID exactly as listed in a tool result's facts, e.g. r_7f3a9c21.f4. Never build it yourself."
    ),
  value: z
    .union([z.number(), z.string().min(1).max(TEXT_MAX)])
    .describe(
      'The value as stated: a number, or a string in the answer format with comma thousands separators and a dot decimal point ("4,747,963", "37.5"; "1.204" is a decimal); a time as ISO-8601 UTC prefix ("2005-06-03", "2005-06-03T15:42Z").'
    ),
  metric: z
    .string()
    .min(1)
    .max(TEXT_MAX)
    .describe(
      "Metric the text names, e.g. events or requests; must equal the fact's metric."
    ),
  group: claimGroupSchema,
  unit: z
    .literal("percent")
    .optional()
    .describe(
      "percent when a ratio is stated in percent (37.5 for 0.375); percent facts such as pct_change are stated as they are."
    ),
})

export type Claim = z.infer<typeof claimSchema>

export const checkClaimsInputSchema = z.strictObject({
  claims: z
    .array(claimSchema)
    .min(1)
    .max(CLAIMS_MAX)
    .describe(
      `1–${CLAIMS_MAX} claims: every number the answer states, each with the fact ID it cites.`
    ),
})

export type CheckClaimsInput = z.infer<typeof checkClaimsInputSchema>

export const claimStatusSchema = z
  .enum(["verified", "mismatch", "unknown_fact", "unknown_receipt"])
  .describe(
    "verified: value, metric and group match the cited fact. mismatch: at least one differs (mismatch_on). unknown_fact: malformed ID, or the receipt has no such fact. unknown_receipt: no receipt with that ID. Both unknown statuses count as unresolved."
  )

const count = z.number().int().nonnegative()

export const claimResultSchema = z.strictObject({
  claim: claimSchema.describe("The claim as submitted."),
  status: claimStatusSchema,
  mismatch_on: z
    .array(z.enum(["value", "metric", "group"]))
    .describe("Differing fields for mismatch, in this order; empty otherwise."),
  reason: z
    .string()
    .nullable()
    .describe(
      "Why the claim is not verified and how to correct it; null when verified."
    ),
  fact: z
    .strictObject({
      value: factValueSchema,
      metric: z.string(),
      unit: z.string(),
      group: z.record(z.string(), z.string()),
    })
    .nullable()
    .describe("The cited fact; null when unresolved."),
  receipt: z
    .strictObject({
      receipt_id: receiptIdSchema,
      tool: z.string(),
      data_version: z.string(),
      scope: scopeSchema,
    })
    .nullable()
    .describe(
      "The receipt of the cited fact with its scope; null for unknown_receipt and malformed IDs."
    ),
})

export type ClaimResult = z.infer<typeof claimResultSchema>

export const checkClaimsOutputSchema = z.strictObject({
  claims: z
    .array(claimResultSchema)
    .max(CLAIMS_MAX)
    .describe("One result per claim, in input order."),
  summary: z
    .strictObject({
      checked: count.describe("Claims submitted and checked."),
      verified: count,
      mismatch: count,
      unresolved: count.describe("unknown_fact plus unknown_receipt."),
      text: z
        .string()
        .describe(
          'Verification line for the answer: "N claims checked · M mismatch · K unresolved".'
        ),
    })
    .describe(
      "Counts over the claims above; checked = verified + mismatch + unresolved."
    ),
})

export type CheckClaimsOutput = z.infer<typeof checkClaimsOutputSchema>

/** Facts for the summary counts only; the cited facts keep their own IDs. */
export const CHECK_CLAIMS_FACT_SPECS: readonly FactSpec[] = (
  ["checked", "verified", "mismatch", "unresolved"] as const
).map((field) => ({
  path: `/result/summary/${field}`,
  metric: `claims_${field}`,
  unit: "claims",
  groupKeys: [],
}))

export function claimsSummary(
  counts: ClaimCounts
): CheckClaimsOutput["summary"] {
  return { ...counts, text: verificationLine(counts) }
}

/**
 * Short text for clients without structured output (MCP text block, § 9):
 * the verification line, then every claim that is not verified with its
 * reason, so the model can correct or drop it. Submitted strings and fact
 * groups appear as JSON literals because they come from model output or
 * log-derived dimension values.
 */
export function summarizeCheckClaims(
  result: ToolResult<CheckClaimsOutput>
): string {
  const { data, facts, receipt, notes } = result
  const byPath = new Map<string, Fact>(facts.map((fact) => [fact.path, fact]))
  const cite = (field: string) => {
    const fact = byPath.get(`/result/summary/${field}`)
    return fact === undefined ? "" : ` [${fact.id}]`
  }
  const { summary } = data
  const open = data.claims
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status !== "verified")
  const lines = [
    `check_claims · receipt ${receipt.receipt_id}`,
    summary.text,
    `Counts: checked ${summary.checked}${cite("checked")}, verified ${summary.verified}${cite("verified")}, mismatch ${summary.mismatch}${cite("mismatch")}, unresolved ${summary.unresolved}${cite("unresolved")}.`,
    open.length === 0
      ? "Every submitted claim matches its fact."
      : "Not verified; correct or drop these claims:",
    ...open.map(({ item, index }) => {
      const { claim } = item
      const on =
        item.mismatch_on.length === 0
          ? ""
          : ` on ${item.mismatch_on.join(", ")}`
      const percent = claim.unit === "percent" ? " %" : ""
      const fact =
        item.fact === null
          ? ""
          : ` Fact: ${formatFactValue(item.fact.value)} ${JSON.stringify(item.fact.metric)}, group ${canonicalJson(item.fact.group)}.`
      return `${index + 1}. ${JSON.stringify(claim.fact)} ${item.status}${on}: claimed ${JSON.stringify(claim.value)}${percent} ${JSON.stringify(claim.metric)}, group ${canonicalJson(claim.group)}. ${item.reason ?? ""}.${fact}`
    }),
    ...notes.map((note) => `Note: ${note}`),
  ]
  return lines.join("\n")
}
