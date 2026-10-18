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
 * Real S-15 answers (engineer role, dev-eng-01). Each answer is paired with its
 * stored check_claims receipt; the SubmittedCheck is built from that receipt's
 * result, which matches checkClaimsOutputSchema exactly. Expected counts below
 * are read off the stored fixtures and the documented rules, never computed
 * with the functions under test.
 *
 * Documented facts about these three answers:
 * - All three use PLAIN-TEXT section lines (no Markdown heading, no leading
 *   bold), so detectSections reports every required section missing. This is
 *   the UI-02 limitation (ui-concept 4.3, § 15): recognition is restricted to
 *   headings and leading-bold names on purpose, so the structure view neither
 *   invents nor reorders sections. All 9 engineer sections are "missing".
 * - Their only submitted check is all-verified, so there is no mismatch or
 *   unresolved finding. The facts cited but NOT submitted are the Verification
 *   summary facts (e.g. r_99539bc6.f1..f3), which common.md says are not
 *   re-checked; the syntactic gate still marks them `unchecked` (plus, in
 *   s15-01, the scope-boundary facts that were cited but not submitted).
 * - uncited flags are the documented UI-03 cases: the peer IP 172.16.96.116
 *   (not in a code span), the trend-table date column with no fact ID, and bare
 *   window/prose numbers such as "10 minutes" or "the 9 June burst". These are
 *   rule behaviour, not exceptions.
 */
const S15_DIR = fileURLToPath(
  new URL("../../evals/results/s15-2026-10-18/", import.meta.url)
)

function loadAnswer(id: string): string {
  return readFileSync(`${S15_DIR}${id}-answer.txt`, "utf8")
}

function loadChecks(id: string): SubmittedCheck[] {
  const evidence = JSON.parse(
    readFileSync(`${S15_DIR}${id}-evidence.json`, "utf8")
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

describe("real S-15 answers", () => {
  // Hand-read from the fixtures: unchecked = distinct cited fact IDs not in any
  // submitted claim, counted per citation occurrence; uncited and missing
  // section counts per the documented rules above.
  const expected = {
    "s15-01": {
      unchecked: 7,
      uncited: 11,
      missing: 9,
      mismatch: 0,
      unresolved: 0,
    },
    "s15-02": {
      unchecked: 3,
      uncited: 13,
      missing: 9,
      mismatch: 0,
      unresolved: 0,
    },
    "s15-03": {
      unchecked: 3,
      uncited: 17,
      missing: 9,
      mismatch: 0,
      unresolved: 0,
    },
  } as const

  for (const id of ["s15-01", "s15-02", "s15-03"] as const) {
    describe(`${id}`, () => {
      const text = loadAnswer(id)
      const checks = loadChecks(id)

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
        expect(report.missing).toHaveLength(expected[id].missing)
      })

      it("produces the documented finding counts", () => {
        const findings = answerFindings({ text, role: "engineer", checks })
        const counts = kinds(findings)
        expect(counts.mismatch ?? 0).toBe(expected[id].mismatch)
        expect(counts.unresolved ?? 0).toBe(expected[id].unresolved)
        expect(counts.unchecked ?? 0).toBe(expected[id].unchecked)
        expect(counts.uncited ?? 0).toBe(expected[id].uncited)
        expect(counts.missing_section ?? 0).toBe(expected[id].missing)
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
