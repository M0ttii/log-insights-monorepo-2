import { compareClaim, countClaims } from "@workspace/domain/claims"
import { CITATION_EXAMPLE } from "@workspace/domain/facts"
import { parseFactId } from "@workspace/domain/ids"
import type { Receipt } from "@workspace/domain/receipt"
import {
  defineTool,
  READ_ONLY_ANNOTATIONS,
  renderDescription,
} from "@workspace/domain/tool"
import {
  CHECK_CLAIMS_FACT_SPECS,
  CLAIMS_MAX,
  checkClaimsInputSchema,
  checkClaimsOutputSchema,
  claimsSummary,
  summarizeCheckClaims,
  type Claim,
  type ClaimResult,
} from "@workspace/domain/tools/check-claims"

/**
 * check_claims (A-14, S-08): resolves each cited fact ID through the
 * receipt store and compares value, metric and group with the pure rules
 * in domain/claims. It reads receipt files only, never the corpus, and
 * writes its own receipt like every tool run (`sql: []`, empty scope
 * windows, population null), with facts for the summary counts.
 *
 * Each receipt is read once per call, however many claims cite it. A
 * receipt written by another process is readable as soon as its ID is
 * known, because the store links complete files into place (U05).
 */

const NOTES = [
  "Only the submitted claims were checked: numbers, their metric and their group. Explanations, hypotheses, causal statements and numbers without a fact ID are not checked; do not claim a complete check.",
  "A value found only in another fact does not verify a claim; numbers you derived yourself (sums, own percentages) are not facts.",
]

export const checkClaims = defineTool({
  name: "check_claims",
  title: "Check claims",
  version: "1.0.0",
  description: renderDescription({
    purpose:
      "Checks the numbers of an answer against the facts the tools returned: for each claim it resolves the cited fact ID and compares the stated value, metric and group with that fact. It checks numbers only, not explanations or causal statements, and only the claims submitted.",
    useWhen: `call before the final answer with every number you state, each with the fact ID you cite (number format: ${CITATION_EXAMPLE}). Then correct or drop every claim that is not verified and put the summary line ("N claims checked · M mismatch · K unresolved") into the Verification section.`,
    doNotUseWhen: [
      {
        situation:
          "you still need a number; a value found in another fact is no evidence",
        use: "count_events, event_trend or the tool that computes it",
      },
      {
        situation:
          "you want to test a hypothesis or a cause; this tool does not judge explanations",
        use: "a discriminating check with count_events, event_trend or search_logs",
      },
    ],
    inputs: `claims (1–${CLAIMS_MAX}), each with fact (ID exactly as listed in a tool result's facts, e.g. r_7f3a9c21.f4), value (number or string; comma = thousands separator, dot = decimal point: "4,747,963", "37.5", 0.375; "1.204" is a decimal, never 1204; times as ISO-8601 UTC prefix: "2005-06-03", "2005-06-03T15:42Z"), metric (the metric the text names, e.g. events), group (required; the dimension values the text attributes the number to, e.g. {"dataset":"bgl","team":"Compute Platform"}; {} for ungrouped facts) and optional unit "percent" (a ratio stated in percent: 37.5 for 0.375). Integers must match exactly; decimals match when the fact rounded half away from zero to the stated decimal places equals the value (0.38 matches 0.375, 0.37 does not); times match as prefix.`,
    outputs:
      "claims[] in input order with status (verified, mismatch, unknown_fact, unknown_receipt), mismatch_on (value, metric, group), reason, the cited fact (value, metric, unit, group) and its receipt (tool, data_version, scope); summary with checked, verified, mismatch, unresolved (unknown_fact + unknown_receipt) and the text line. A malformed fact ID is unknown_fact for that claim only.",
    truncation: `none; at most ${CLAIMS_MAX} claims per call, every claim gets a result.`,
    countingUnit:
      "claims (submitted numbers), not log events; the cited facts keep their own units.",
  }),
  input: checkClaimsInputSchema,
  output: checkClaimsOutputSchema,
  factSpecs: CHECK_CLAIMS_FACT_SPECS,
  annotations: READ_ONLY_ANNOTATIONS,
  async run(ctx, input) {
    const reads = new Map<string, Promise<Receipt | null>>()
    const read = (id: string) => {
      let receipt = reads.get(id)
      if (receipt === undefined) {
        receipt = ctx.receipts.get(id)
        reads.set(id, receipt)
      }
      return receipt
    }

    const claims = await Promise.all(
      input.claims.map((claim) => checkOne(claim, read))
    )
    const summary = claimsSummary(countClaims(claims.map((c) => c.status)))

    return {
      ok: true,
      run: {
        data: { claims, summary },
        scope: { windows: [], filters: {} },
        population: null,
        rows_returned: claims.length,
        truncated: false,
        row_limit: null,
        notes: [...NOTES],
      },
    }
  },
  summary: summarizeCheckClaims,
})

async function checkOne(
  claim: Claim,
  read: (id: string) => Promise<Receipt | null>
): Promise<ClaimResult> {
  const unresolved = (
    status: "unknown_fact" | "unknown_receipt",
    reason: string,
    receipt: ClaimResult["receipt"]
  ): ClaimResult => ({
    claim,
    status,
    mismatch_on: [],
    reason,
    fact: null,
    receipt,
  })

  // Validated before the ID forms a file path (§ 6.2).
  const id = parseFactId(claim.fact)
  if (id === null)
    return unresolved(
      "unknown_fact",
      `${JSON.stringify(claim.fact)} is not a fact ID (r_ + 8 lower-case hex digits + .f + number, e.g. r_7f3a9c21.f4); copy IDs from a tool result's facts`,
      null
    )

  const receipt = await read(id.receiptId)
  if (receipt === null)
    return unresolved(
      "unknown_receipt",
      `no receipt ${id.receiptId} exists; cite fact IDs exactly as a tool returned them`,
      null
    )

  const source = {
    receipt_id: receipt.receipt_id,
    tool: receipt.tool,
    data_version: receipt.data_version,
    scope: receipt.scope,
  }
  const fact = receipt.facts.find((candidate) => candidate.id === claim.fact)
  if (fact === undefined) {
    const range =
      receipt.facts.length === 0
        ? "no facts"
        : `facts f1–f${receipt.facts.length}`
    return unresolved(
      "unknown_fact",
      `receipt ${receipt.receipt_id} (${receipt.tool}) has ${range}; cite an ID from its facts`,
      source
    )
  }

  const comparison = compareClaim(claim, fact)
  return {
    claim,
    status: comparison.status,
    mismatch_on: comparison.status === "mismatch" ? comparison.mismatch_on : [],
    reason: comparison.status === "mismatch" ? comparison.reason : null,
    fact: {
      value: fact.value,
      metric: fact.metric,
      unit: fact.unit,
      group: fact.group,
    },
    receipt: source,
  }
}
