import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import {
  answerFindings,
  answerRoleSchema,
  detectSections,
  extractCitations,
  findUncited,
  findingsFeedback,
  gateFindingSchema,
  ROLE_SECTIONS,
  submittedCheckSchema,
  type GateFinding,
  type SubmittedCheck,
} from "./answer.ts"
import { checkClaimsOutputSchema } from "./tools/check-claims.ts"

/**
 * Expected values are hand-authored or read straight from the stored eval
 * fixtures; they are never computed with the functions under test.
 */

/** Builds a check_claims output from compact claim specs (test oracle only). */
function check(
  receipt: string,
  claims: {
    fact: string
    status: "verified" | "mismatch" | "unknown_fact" | "unknown_receipt"
    on?: ("value" | "metric" | "group")[]
  }[]
): SubmittedCheck {
  return submittedCheckSchema.parse({
    receipt_id: receipt,
    output: {
      claims: claims.map((claim) => ({
        claim: { fact: claim.fact, value: 1, metric: "events", group: {} },
        status: claim.status,
        mismatch_on: claim.on ?? [],
        reason: claim.status === "verified" ? null : "reason",
        fact:
          claim.status === "verified" || claim.status === "mismatch"
            ? { value: 1, metric: "events", unit: "events", group: {} }
            : null,
        receipt:
          claim.status === "unknown_receipt"
            ? null
            : {
                receipt_id: "r_00000000",
                tool: "count_events",
                data_version: "v1",
                scope: { windows: [], filters: {} },
              },
      })),
      summary: {
        checked: claims.length,
        verified: claims.filter((c) => c.status === "verified").length,
        mismatch: claims.filter((c) => c.status === "mismatch").length,
        unresolved: claims.filter(
          (c) => c.status === "unknown_fact" || c.status === "unknown_receipt"
        ).length,
        text: "oracle",
      },
    },
  })
}

const kinds = (findings: GateFinding[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const finding of findings)
    counts[finding.kind] = (counts[finding.kind] ?? 0) + 1
  return counts
}

describe("answerRoleSchema", () => {
  it("accepts the three roles and rejects auto", () => {
    expect(answerRoleSchema.options).toEqual([
      "engineer",
      "team_lead",
      "manager",
    ])
    expect(answerRoleSchema.safeParse("auto").success).toBe(false)
  })
})

describe("extractCitations", () => {
  it("reads fact and receipt IDs with positions", () => {
    const text = "count 5 [r_7f3a9c21.f4] and receipt [r_7f3a9c21]."
    const cites = extractCitations(text)
    expect(cites).toEqual([
      {
        kind: "fact",
        id: "r_7f3a9c21.f4",
        receiptId: "r_7f3a9c21",
        start: text.indexOf("r_7f3a9c21.f4"),
        end: text.indexOf("r_7f3a9c21.f4") + "r_7f3a9c21.f4".length,
      },
      {
        kind: "receipt",
        id: "r_7f3a9c21",
        receiptId: "r_7f3a9c21",
        start: text.lastIndexOf("r_7f3a9c21"),
        end: text.lastIndexOf("r_7f3a9c21") + "r_7f3a9c21".length,
      },
    ])
  })

  it("accepts several IDs in one bracket", () => {
    const cites = extractCitations("see [r_aaaaaaaa.f1, r_bbbbbbbb.f2] done")
    expect(cites.map((c) => c.id)).toEqual(["r_aaaaaaaa.f1", "r_bbbbbbbb.f2"])
    expect(cites.map((c) => c.kind)).toEqual(["fact", "fact"])
  })

  it("reads adjacent brackets as separate citations", () => {
    const cites = extractCitations(
      "[r_da3bc138.f1][r_da3bc138.f2][r_da3bc138.f3]"
    )
    expect(cites.map((c) => c.id)).toEqual([
      "r_da3bc138.f1",
      "r_da3bc138.f2",
      "r_da3bc138.f3",
    ])
  })

  it("excludes IDs inside code spans and fenced blocks", () => {
    expect(extractCitations("inline `[r_7f3a9c21.f4]` only")).toEqual([])
    expect(extractCitations("```\n[r_7f3a9c21.f4]\n```\nafter")).toEqual([])
  })

  it("returns nothing for empty text", () => {
    expect(extractCitations("")).toEqual([])
  })
})

describe("findUncited", () => {
  it("flags a number with no following fact ID", () => {
    const text = "There were 512 nodes."
    expect(findUncited(text).map((u) => u.value)).toEqual(["512"])
  })

  it("accepts a fact ID after the unit or word", () => {
    expect(findUncited("1,204 log events [r_7f3a9c21.f4]")).toEqual([])
  })

  it("flags only the number with no citation before the next number", () => {
    const text = "512 nodes [r_7f3a9c21.f1] across 32 racks."
    expect(findUncited(text).map((u) => u.value)).toEqual(["32"])
  })

  it("treats a table cell as a boundary", () => {
    // The date in cell 1 has no citation before the cell break; the count in
    // cell 2 is cited. Only the date is uncited.
    const text = "2005-06-04 | 2,040 [r_ebd8234b.f3]"
    expect(findUncited(text).map((u) => u.value)).toEqual(["2005-06-04"])
  })

  it("excludes digits in code spans (nodes, racks)", () => {
    const text = "node `R00-M0-N0-I:J18-U01` logged 15 events [r_7f3a9c21.f2]"
    expect(findUncited(text)).toEqual([])
  })

  it("excludes digits inside fact and receipt IDs", () => {
    // No standalone number; every digit belongs to a fact or receipt ID.
    const text = "see [r_7f3a9c21.f4] and [r_12345678] only"
    expect(findUncited(text)).toEqual([])
  })

  it("excludes ordered-list markers and heading hashes", () => {
    const text =
      "## Section\n1. first [r_7f3a9c21.f1]\n2. second [r_7f3a9c21.f2]"
    expect(findUncited(text)).toEqual([])
  })

  it("treats dates, times, percents, decimals and thousands as single tokens", () => {
    expect(findUncited("at 2005-06-03T15:42Z").map((u) => u.value)).toEqual([
      "2005-06-03T15:42Z",
    ])
    expect(findUncited("at 15:42 today").map((u) => u.value)).toEqual(["15:42"])
    expect(findUncited("up 37.5% this week").map((u) => u.value)).toEqual([
      "37.5%",
    ])
    expect(findUncited("over 4,747,963 events").map((u) => u.value)).toEqual([
      "4,747,963",
    ])
  })

  it("treats a dotted IPv4 address as one token", () => {
    const uncited = findUncited("peer 172.16.96.116 dropped")
    expect(uncited.map((u) => u.value)).toEqual(["172.16.96.116"])
  })

  it("does not split numbers out of identifiers like dat32k_060205", () => {
    expect(findUncited("path /p/gb2/dat32k_060205 here")).toEqual([])
  })

  it("flags each repeated number occurrence", () => {
    const text = "5 here and 5 there."
    expect(findUncited(text).map((u) => u.value)).toEqual(["5", "5"])
  })

  it("returns nothing for empty text", () => {
    expect(findUncited("")).toEqual([])
  })
})

describe("ROLE_SECTIONS and detectSections", () => {
  it("names the frame and per-role core from the playbooks", () => {
    expect(ROLE_SECTIONS.frame).toEqual([
      "Scope",
      "Answer",
      "Unknown",
      "Verification",
    ])
    expect(ROLE_SECTIONS.core.engineer).toEqual([
      "Evidence",
      "Timeline",
      "Narrowing",
      "Hypotheses",
      "Next check",
    ])
    expect(ROLE_SECTIONS.core.team_lead).toEqual([
      "Recurring patterns",
      "Recurring vs. one-off",
      "Investigate first",
      "Improvement",
    ])
    expect(ROLE_SECTIONS.core.manager).toEqual([
      "Priorities",
      "Why this order",
      "Decision needed",
      "Missing information",
    ])
  })

  it("recognises Markdown headings, case-insensitively and with a trailing colon", () => {
    const text = "## scope:\n### ANSWER\n# Unknown\nVerification\n"
    const report = detectSections(text, null)
    expect(report.present).toEqual(["Scope", "Answer", "Unknown"])
    // Plain-text "Verification" line is not a heading or bold -> missing.
    expect(report.missing).toEqual([{ section: "Verification", part: "frame" }])
  })

  it("recognises paragraph-leading bold names", () => {
    const text =
      "**Scope** bgl\n**Answer** job-wide\n**Unknown** causes\n**Verification** 3 checked"
    const report = detectSections(text, null)
    expect(report.present).toEqual([
      "Scope",
      "Answer",
      "Unknown",
      "Verification",
    ])
    expect(report.missing).toEqual([])
  })

  it("requires the role core when a role is given", () => {
    const text =
      "## Scope\n## Answer\n## Evidence\n## Timeline\n## Narrowing\n## Hypotheses\n## Next check\n## Unknown\n## Verification"
    expect(detectSections(text, "engineer").missing).toEqual([])
  })

  it("reports missing frame and core sections", () => {
    const report = detectSections("## Answer\nsome prose", "manager")
    expect(report.present).toEqual(["Answer"])
    expect(report.missing).toEqual([
      { section: "Scope", part: "frame" },
      { section: "Unknown", part: "frame" },
      { section: "Verification", part: "frame" },
      { section: "Priorities", part: "core" },
      { section: "Why this order", part: "core" },
      { section: "Decision needed", part: "core" },
      { section: "Missing information", part: "core" },
    ])
  })

  it("requires only the frame for a null role", () => {
    const report = detectSections(
      "## Scope\n## Answer\n## Unknown\n## Verification",
      null
    )
    expect(report.missing).toEqual([])
    expect(report.present).toEqual([
      "Scope",
      "Answer",
      "Unknown",
      "Verification",
    ])
  })
})

describe("answerFindings", () => {
  const sectioned =
    "## Scope\nbgl\n## Answer\nx\n## Evidence\n## Timeline\n## Narrowing\n## Hypotheses\n## Next check\n## Unknown\n## Verification\n"

  it("returns no_check when no checks are submitted", () => {
    expect(
      answerFindings({ text: "anything", role: null, checks: [] })
    ).toEqual([{ kind: "no_check" }])
  })

  it("reports a mismatch from the latest check and its excerpt", () => {
    const text = `${sectioned}The count was 5 events [r_7f3a9c21.f4].`
    const findings = answerFindings({
      text,
      role: "engineer",
      checks: [
        check("r_11111111", [
          { fact: "r_7f3a9c21.f4", status: "mismatch", on: ["group"] },
        ]),
      ],
    })
    const mismatch = findings.find((f) => f.kind === "mismatch")
    expect(mismatch).toEqual({
      kind: "mismatch",
      fact: "r_7f3a9c21.f4",
      mismatch_on: ["group"],
      check_receipt_id: "r_11111111",
      excerpt: "The count was 5 events [r_7f3a9c21.f4].",
    })
  })

  it("lets a later verified re-submission supersede an earlier mismatch", () => {
    const text = `${sectioned}The count was 5 events [r_7f3a9c21.f4].`
    const findings = answerFindings({
      text,
      role: "engineer",
      checks: [
        check("r_11111111", [
          { fact: "r_7f3a9c21.f4", status: "mismatch", on: ["group"] },
        ]),
        check("r_22222222", [{ fact: "r_7f3a9c21.f4", status: "verified" }]),
      ],
    })
    expect(findings.some((f) => f.kind === "mismatch")).toBe(false)
    expect(findings.some((f) => f.kind === "unchecked")).toBe(false)
  })

  it("lets a later mismatch supersede an earlier verified result", () => {
    const text = `${sectioned}The count was 5 events [r_7f3a9c21.f4].`
    const findings = answerFindings({
      text,
      role: "engineer",
      checks: [
        check("r_11111111", [{ fact: "r_7f3a9c21.f4", status: "verified" }]),
        check("r_22222222", [
          { fact: "r_7f3a9c21.f4", status: "mismatch", on: ["value"] },
        ]),
      ],
    })
    const mismatch = findings.find((f) => f.kind === "mismatch")
    expect(mismatch).toEqual({
      kind: "mismatch",
      fact: "r_7f3a9c21.f4",
      mismatch_on: ["value"],
      check_receipt_id: "r_22222222",
      excerpt: "The count was 5 events [r_7f3a9c21.f4].",
    })
  })

  it("flags unknown fact and unknown receipt as unresolved", () => {
    const text = `${sectioned}A [r_7f3a9c21.f9] and B [r_deadbeef.f1].`
    const findings = answerFindings({
      text,
      role: "engineer",
      checks: [
        check("r_11111111", [
          { fact: "r_7f3a9c21.f9", status: "unknown_fact" },
          { fact: "r_deadbeef.f1", status: "unknown_receipt" },
        ]),
      ],
    })
    const unresolved = findings.filter((f) => f.kind === "unresolved")
    expect(unresolved).toEqual([
      {
        kind: "unresolved",
        fact: "r_7f3a9c21.f9",
        status: "unknown_fact",
        check_receipt_id: "r_11111111",
        excerpt: "A [r_7f3a9c21.f9] and B [r_deadbeef.f1].",
      },
      {
        kind: "unresolved",
        fact: "r_deadbeef.f1",
        status: "unknown_receipt",
        check_receipt_id: "r_11111111",
        excerpt: "A [r_7f3a9c21.f9] and B [r_deadbeef.f1].",
      },
    ])
  })

  it("flags an unchecked fact that no claim submitted", () => {
    const text = `${sectioned}Cited [r_7f3a9c21.f4] but never checked.`
    const findings = answerFindings({
      text,
      role: "engineer",
      checks: [
        check("r_11111111", [{ fact: "r_bbbbbbbb.f1", status: "verified" }]),
      ],
    })
    const unchecked = findings.filter((f) => f.kind === "unchecked")
    expect(unchecked).toHaveLength(1)
    expect(unchecked[0]).toMatchObject({
      kind: "unchecked",
      fact: "r_7f3a9c21.f4",
    })
  })

  it("does not flag unchecked for a receipt-only citation", () => {
    const text = `${sectioned}See receipt [r_7f3a9c21] only.`
    const findings = answerFindings({
      text,
      role: "engineer",
      checks: [
        check("r_11111111", [{ fact: "r_bbbbbbbb.f1", status: "verified" }]),
      ],
    })
    expect(findings.some((f) => f.kind === "unchecked")).toBe(false)
  })

  it("does not flag the summary facts of a submitted check_claims receipt as unchecked", () => {
    // The Verification line cites the submitted check's own summary facts
    // (r_11111111.f1..f3). common.md says these come straight from that check
    // and are not re-submitted to it, so they are exempt from `unchecked`.
    const text = `${sectioned}Verification: 1 claims checked [r_11111111.f1] · 0 mismatch [r_11111111.f2] · 0 unresolved [r_11111111.f3].`
    const findings = answerFindings({
      text,
      role: "engineer",
      checks: [
        check("r_11111111", [{ fact: "r_bbbbbbbb.f1", status: "verified" }]),
      ],
    })
    expect(findings.some((f) => f.kind === "unchecked")).toBe(false)
  })

  it("still flags a fact from a different, unsubmitted check_claims-like receipt as unchecked", () => {
    // r_99999999 is NOT the submitted check receipt (r_11111111); even though
    // it looks like a check summary citation, its facts were never submitted,
    // so the exemption does not apply and they remain `unchecked`.
    const text = `${sectioned}Verification: 1 claims checked [r_99999999.f1] · 0 mismatch [r_99999999.f2].`
    const findings = answerFindings({
      text,
      role: "engineer",
      checks: [
        check("r_11111111", [{ fact: "r_bbbbbbbb.f1", status: "verified" }]),
      ],
    })
    const unchecked = findings.filter((f) => f.kind === "unchecked")
    expect(
      unchecked.map((f) => (f.kind === "unchecked" ? f.fact : ""))
    ).toEqual(["r_99999999.f1", "r_99999999.f2"])
  })

  it("orders findings deterministically: mismatch/unresolved, unchecked, uncited, sections", () => {
    // "9 racks." has no fact ID before the sentence break -> uncited.
    // r_cccccccc.f2 is cited but not submitted -> unchecked.
    // r_7f3a9c21.f4 is a mismatch in the only check.
    const text = `${sectioned}Count 5 events [r_7f3a9c21.f4] over [r_cccccccc.f2]. Then 9 racks.`
    const findings = answerFindings({
      text,
      role: "engineer",
      checks: [
        check("r_11111111", [
          { fact: "r_7f3a9c21.f4", status: "mismatch", on: ["metric"] },
        ]),
      ],
    })
    const order = findings.map((f) => f.kind)
    const firstUncited = order.indexOf("uncited")
    const firstUnchecked = order.indexOf("unchecked")
    const firstMismatch = order.indexOf("mismatch")
    expect(firstMismatch).toBeGreaterThanOrEqual(0)
    expect(firstUnchecked).toBeGreaterThan(firstMismatch)
    expect(firstUncited).toBeGreaterThan(firstUnchecked)
    // The sectioned preamble is complete, so there is no missing_section here.
    expect(order.includes("missing_section")).toBe(false)
    expect(
      findings.some((f) => f.kind === "unchecked" && f.fact === "r_cccccccc.f2")
    ).toBe(true)
    expect(findings.some((f) => f.kind === "uncited" && f.value === "9")).toBe(
      true
    )
  })

  it("places missing_section findings last", () => {
    // No sections at all -> all section findings; a trailing uncited number.
    const text = "Count 9 racks with no sections."
    const findings = answerFindings({
      text,
      role: "engineer",
      checks: [
        check("r_11111111", [{ fact: "r_aaaaaaaa.f1", status: "verified" }]),
      ],
    })
    const order = findings.map((f) => f.kind)
    const lastNonSection = order.reduce(
      (acc, kind, index) => (kind === "missing_section" ? acc : index),
      -1
    )
    const firstSection = order.indexOf("missing_section")
    expect(firstSection).toBeGreaterThan(lastNonSection)
  })

  it("every finding validates against gateFindingSchema", () => {
    const text = `Count 9 and [r_7f3a9c21.f4] cited [r_cccccccc.f2].`
    const findings = answerFindings({
      text,
      role: "engineer",
      checks: [
        check("r_11111111", [
          { fact: "r_7f3a9c21.f4", status: "unknown_fact" },
        ]),
      ],
    })
    for (const finding of findings) {
      expect(gateFindingSchema.safeParse(finding).success).toBe(true)
    }
  })
})

describe("findingsFeedback", () => {
  it("is empty for no findings", () => {
    expect(findingsFeedback([])).toBe("")
  })

  it("writes one deterministic English line per finding", () => {
    const lines = findingsFeedback([
      {
        kind: "mismatch",
        fact: "r_7f3a9c21.f4",
        mismatch_on: ["group"],
        check_receipt_id: "r_1",
        excerpt: "job-wide across 32 racks [r_7f3a9c21.f4]",
      },
      { kind: "missing_section", section: "Next check", part: "core" },
    ])
    expect(lines.split("\n")).toEqual([
      'Sentence "job-wide across 32 racks [r_7f3a9c21.f4]": fact r_7f3a9c21.f4 mismatch on group. Correct the claim or remove it.',
      'Missing section: Next check. Add the role core section "Next check".',
    ])
  })

  it("renders no_check, unresolved, unchecked and uncited lines", () => {
    expect(findingsFeedback([{ kind: "no_check" }])).toContain(
      "No check_claims"
    )
    expect(
      findingsFeedback([
        {
          kind: "unresolved",
          fact: "r_a.f1",
          status: "unknown_receipt",
          check_receipt_id: "r_1",
          excerpt: null,
        },
      ])
    ).toContain("unresolved")
    expect(
      findingsFeedback([
        { kind: "unchecked", fact: "r_a.f1", start: 0, end: 1, excerpt: "x" },
      ])
    ).toContain("not submitted to check_claims")
    expect(
      findingsFeedback([
        {
          kind: "uncited",
          value: "512",
          start: 0,
          end: 3,
          excerpt: "512 nodes",
        },
      ])
    ).toContain("has no fact ID")
  })
})

/**
 * Real S-15 answers (engineer role, dev-eng-01), across every valid eval round:
 * the base round s15-2026-10-18/ plus the regression rounds -r2, -r3 and -r5.
 * Each answer is paired with its stored check_claims receipt; the SubmittedCheck
 * is built from that receipt's result, which matches checkClaimsOutputSchema
 * exactly. Every expected count below is RE-DERIVED BY HAND from the stored
 * fixtures and the documented rules (ui-concept 4.3 / UI-02 / UI-03), never by
 * running answerFindings/findUncited and copying the output.
 *
 * -r4 is deliberately excluded: its manifest records
 * `execution_status: aborted_round_due_to_invalid_runtime_and_duplicate_input`,
 * its only trial r4-01 was stopped by the operator before the log search
 * (`stopped_by_operator: true`), and r4-01-answer.txt is an "I've stopped"
 * message with no answer frame, no Verification line and no check_claims call.
 * It is not a complete, scorable answer, so there is nothing to hand-derive.
 *
 * Why every section reads as missing (a CAPTURE artifact, not model behaviour):
 * every answer here is an accessibility transcription with "layout normalized"
 * (each round's manifest.json `capture` field). The transcription keeps the
 * visible text but drops Markdown structure: the model's `## Scope` headings and
 * `**Answer**` bold run became plain-text lines. detectSections only recognises
 * ATX headings and paragraph-leading bold names (UI-02, on purpose, so the
 * structure view never invents or reorders sections), so with the markup gone it
 * reports all 9 engineer sections (4 frame + 5 core) missing. This is the capture
 * pipeline, not the model omitting sections.
 *
 * unchecked (the LOG-46 rule change): every answer's only submitted check is
 * all-verified, so there is no mismatch or unresolved finding. The facts cited
 * but NOT submitted are the Verification-line summary facts (e.g.
 * r_99539bc6.f1..f3) — and common.md states those come directly from that check
 * and are deliberately not re-submitted to it. Since the coordinator's rule
 * change, a fact whose receipt is one of the submitted check receipts is EXEMPT
 * from `unchecked`. So for almost every answer unchecked is now 0. The two
 * exceptions are answers that also cite a non-check receipt's fact without
 * submitting it: s15-01 cites the scope-window / data-start facts
 * (r_a674fc90.f15, r_a674fc90.f16, r_ebd8234b.f30 twice -> 4), and r5-03 cites
 * the data-start fact r_7aa82f5d.f20 (-> 1). Those receipts are not the check
 * receipt, so they stay unchecked. (Before the rule change the three
 * Verification facts were counted too, e.g. s15-01 was 7, s15-02 and s15-03 3.)
 *
 * uncited flags are the documented UI-03 cases and are RULE BEHAVIOUR, not false
 * positives, so none is suppressed by an exception (UI-03 requires fixing the
 * RULE, not hiding a flag — and no flag here is a rule error):
 * - the peer IP 172.16.96.116 written in prose instead of a code span;
 * - trend-table date column values with no adjacent fact ID (full `2005-06-04`,
 *   or the `06` / `4` day fragment the tokenizer reads from `06-04` / `Jun 4`);
 * - bare window/prose numbers ("10 minutes", "6 of 7", a "30"-minute gap, an
 *   "event 14736" index, a ".116" host shorthand, a "502 other nodes" remainder);
 * - Verification-line summary numbers (`27 checked`, the leading `0 mismatch`)
 *   when the model grouped all three fact chips at the END of the line
 *   (`… 0 unresolved [f1][f2][f3]`) instead of one chip per number as the
 *   ui-concept 4.3 canonical form shows: the chip does not fall before the next
 *   number in the sentence, so the earlier numbers are correctly uncited.
 */
type Round = { dir: string; ids: readonly string[] }

const ROUNDS: readonly Round[] = [
  { dir: "s15-2026-10-18", ids: ["s15-01", "s15-02", "s15-03"] },
  { dir: "s15-2026-10-18-r2", ids: ["r2-01", "r2-02", "r2-03"] },
  { dir: "s15-2026-10-18-r3", ids: ["r3-01", "r3-02", "r3-03"] },
  { dir: "s15-2026-10-18-r5", ids: ["r5-01", "r5-02", "r5-03"] },
]

function roundDir(dir: string): string {
  return fileURLToPath(new URL(`../../evals/results/${dir}/`, import.meta.url))
}

function loadAnswer(dir: string, id: string): string {
  return readFileSync(`${roundDir(dir)}${id}-answer.txt`, "utf8")
}

function loadChecks(dir: string, id: string): SubmittedCheck[] {
  const evidence = JSON.parse(
    readFileSync(`${roundDir(dir)}${id}-evidence.json`, "utf8")
  ) as { tool_calls: { tool: string; receipt_id: string; result: unknown }[] }
  return evidence.tool_calls
    .filter((call) => call.tool === "check_claims")
    .map((call) =>
      submittedCheckSchema.parse({
        receipt_id: call.receipt_id,
        output: checkClaimsOutputSchema.parse(call.result),
      })
    )
}

type Expected = {
  unchecked: number
  uncited: number
  missing: number
  mismatch: number
  unresolved: number
}

/**
 * Hand-derived expected counts. missing = 9 everywhere (all section markup lost
 * in capture). mismatch = unresolved = 0 everywhere (every submitted check is
 * all-verified). unchecked and uncited are derived per answer; the uncited
 * breakdown per case is justified in the top-of-block comment and summarised
 * inline here.
 */
const expected: Record<string, Expected> = {
  // 4 unchecked: scope-window f15/f16 + data-start f30 (cited twice) of
  // non-check receipts. 11 uncited: 3 peer-IP mentions + 2 bare 172.16.96.116 in
  // Unknown/Hypotheses (5 total IP), 5 trend-table dates (2005-06-04..20), the
  // "10 minutes" window number, the "2005-06-09" odd-burst date — tallying 11.
  "s15-01": {
    unchecked: 4,
    uncited: 11,
    missing: 9,
    mismatch: 0,
    unresolved: 0,
  },
  // 0 unchecked: the only unsubmitted cited facts are r_e3d3d31f.f1..f3, the
  // Verification summary of the submitted check (now exempt). 13 uncited: the
  // "30"-minute gap, 1 peer IP, 5 trend dates, three "10"/"9"/"6" window numbers
  // in Narrowing/Next check, 1 peer IP in Next check, 1 "10" top-groups number.
  "s15-02": {
    unchecked: 0,
    uncited: 13,
    missing: 9,
    mismatch: 0,
    unresolved: 0,
  },
  // 0 unchecked: only r_da3bc138.f1..f3 (Verification summary, exempt) were
  // unsubmitted. 17 uncited: 1 peer IP, "30"-min gap, 5 inline daily counts
  // (Jun 4..20 -> the "4".."20" day numbers), rack "64", burst "5"-min, "10"-min,
  // host peer IP, "7" bursts, "9" June, host peer IP, "3" (Jun 3), and the
  // grouped-chip Verification numbers "27" and "0".
  "s15-03": {
    unchecked: 0,
    uncited: 17,
    missing: 9,
    mismatch: 0,
    unresolved: 0,
  },

  // r2: all three submit one all-verified check; the only unsubmitted cited
  // facts are each check's own Verification summary (f1..f3), now exempt -> 0.
  // r2-01 uncited 12: 4 peer-IP prose mentions, 5 daily "06" day fragments,
  // "10"-minute window, "6 of 7" -> the "6", "14736" event index, "7" bursts.
  "r2-01": {
    unchecked: 0,
    uncited: 12,
    missing: 9,
    mismatch: 0,
    unresolved: 0,
  },
  // r2-02 uncited 12: scope date "2005-06-03" (no fact), "30"-min gap, 1 peer IP,
  // 5 daily "06" fragments, "10"-min, 2 peer IP, "14736" event index.
  "r2-02": {
    unchecked: 0,
    uncited: 12,
    missing: 9,
    mismatch: 0,
    unresolved: 0,
  },
  // r2-03 uncited 9: 1 peer IP, 5 daily "06" fragments, "10"-min window, 2 peer IP.
  "r2-03": { unchecked: 0, uncited: 9, missing: 9, mismatch: 0, unresolved: 0 },

  // r3-01 uncited 13: "30"-min gap, 1 peer IP, "10"-min, 5 full daily dates,
  // one "07:24:32" clock time, 3 peer IP, scope "2005-06-03".
  "r3-01": {
    unchecked: 0,
    uncited: 13,
    missing: 9,
    mismatch: 0,
    unresolved: 0,
  },
  // r3-02 uncited 22 (the longest): peer IP + ".116" shorthand in the answer,
  // "502" remainder, peer IP, 5 full daily dates, two "07:24" clock times,
  // two "10"-min windows, peer IP, ".116", peer IP, "07:24"+date in Next check,
  // ".116", "10" top-10, and the grouped-chip Verification "27" and "0".
  "r3-02": {
    unchecked: 0,
    uncited: 22,
    missing: 9,
    mismatch: 0,
    unresolved: 0,
  },
  // r3-03 uncited 9: 1 peer IP, 5 inline daily "4".."20" day numbers, "10"-min,
  // 2 peer IP.
  "r3-03": { unchecked: 0, uncited: 9, missing: 9, mismatch: 0, unresolved: 0 },

  // r5-01 uncited 16: 1 peer IP, "30"-min gap, 5 inline daily day numbers,
  // an "Every other day: 0", "10"-min, peer IP, "6"/"7" job-launch numbers,
  // peer IP, "3" (Jun 3), and the grouped-chip Verification "23" and "0".
  "r5-01": {
    unchecked: 0,
    uncited: 16,
    missing: 9,
    mismatch: 0,
    unresolved: 0,
  },
  // r5-02 uncited 7: scope "2005" fragment, peer IP, "5"-min window, "1,021"
  // events, peer IP, "10"-min, peer IP.
  "r5-02": { unchecked: 0, uncited: 7, missing: 9, mismatch: 0, unresolved: 0 },
  // r5-03 unchecked 1: data-start fact r_7aa82f5d.f20 (non-check receipt) cited
  // in Scope, unsubmitted; the Verification facts r_3317ba7d.f1..f3 are exempt.
  // uncited 12: 2 peer IP in the answer line, 1 peer IP, "10"-min, 5 full daily
  // dates, peer IP, "14736" event index, peer IP.
  "r5-03": {
    unchecked: 1,
    uncited: 12,
    missing: 9,
    mismatch: 0,
    unresolved: 0,
  },
}

describe("real S-15 answers", () => {
  for (const { dir, ids } of ROUNDS) {
    describe(`${dir}`, () => {
      for (const id of ids) {
        describe(`${id}`, () => {
          const text = loadAnswer(dir, id)
          const checks = loadChecks(dir, id)
          const want = expected[id]
          if (want === undefined)
            throw new Error(`no hand-derived expectation for ${id}`)

          it("has exactly one all-verified check", () => {
            expect(checks).toHaveLength(1)
            const only = checks[0]
            expect(only?.output.summary.mismatch).toBe(0)
            expect(only?.output.summary.unresolved).toBe(0)
          })

          it("extracts fact citations with valid offsets into the text", () => {
            const cites = extractCitations(text)
            expect(cites.length).toBeGreaterThan(0)
            for (const cite of cites) {
              expect(text.slice(cite.start, cite.end)).toBe(cite.id)
            }
          })

          it("reports every required section missing (plain-text lines, UI-02)", () => {
            const report = detectSections(text, "engineer")
            expect(report.present).toEqual([])
            expect(report.missing).toHaveLength(want.missing)
          })

          it("produces the hand-derived finding counts", () => {
            const findings = answerFindings({ text, role: "engineer", checks })
            const counts = kinds(findings)
            expect(counts.mismatch ?? 0).toBe(want.mismatch)
            expect(counts.unresolved ?? 0).toBe(want.unresolved)
            expect(counts.unchecked ?? 0).toBe(want.unchecked)
            expect(counts.uncited ?? 0).toBe(want.uncited)
            expect(counts.missing_section ?? 0).toBe(want.missing)
          })

          it("does not mark the Verification summary facts unchecked (LOG-46 rule)", () => {
            // The submitted check's own summary facts (r_<check>.fN) are cited
            // by the Verification line but never re-submitted; they must be
            // exempt from `unchecked`.
            const only = checks[0]
            const checkReceipt = only?.receipt_id
            const findings = answerFindings({ text, role: "engineer", checks })
            const uncheckedFromCheck = findings.filter(
              (f) =>
                f.kind === "unchecked" &&
                checkReceipt !== undefined &&
                f.fact.startsWith(`${checkReceipt}.`)
            )
            expect(uncheckedFromCheck).toEqual([])
          })

          it("marks the peer IP 172.16.96.116 uncited (UI-03 documented case)", () => {
            const uncited = findUncited(text)
            expect(uncited.some((u) => u.value === "172.16.96.116")).toBe(true)
          })

          it("feedback has one line per finding", () => {
            const findings = answerFindings({ text, role: "engineer", checks })
            const feedback = findingsFeedback(findings)
            expect(feedback.split("\n")).toHaveLength(findings.length)
          })
        })
      }
    })
  }
})
