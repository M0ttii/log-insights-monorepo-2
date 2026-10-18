import { z } from "zod"

import { FACT_ID_PATTERN, RECEIPT_ID_PATTERN, receiptIdSchema } from "./ids.ts"
import { checkClaimsOutputSchema } from "./tools/check-claims.ts"

/**
 * Pure answer markings and gate findings (LOG-46, technical.md § 8.3 and
 * § 11, ui-concept 4.3 and § 15 UI-02/UI-03). This module is the single
 * implementation behind both the web markings and the agent's answer gate:
 * citation extraction, the `uncited` and `unchecked` markings, section
 * detection and the gate findings. It never checks a value, metric or group
 * itself — only `check_claims` does that (§ 8.3); this module reads the
 * check_claims results it is handed.
 *
 * All offsets are UTF-16 indices into the given text, `end` exclusive, as the
 * web renderer consumes them.
 */

export const answerRoleSchema = z.enum(["engineer", "team_lead", "manager"])
export type AnswerRole = z.infer<typeof answerRoleSchema>

export type Citation = {
  kind: "fact" | "receipt"
  id: string
  /** The receipt ID of the citation (the fact's receipt, or the receipt itself). */
  receiptId: string
  start: number
  end: number
}

/** Max length of an excerpt (sentence or table cell) carried on a finding. */
const EXCERPT_MAX = 160

/**
 * Fact and receipt ID matchers derived from the anchored source patterns in
 * ids.ts, so the literal lives in one place (the ticket forbids a second copy
 * of the regex). The anchored patterns bind `^`/`$`; strip them and reuse the
 * body as an unanchored, global matcher. A fact ID is tried before a bare
 * receipt ID so `r_xxxxxxxx.fN` is read whole rather than as a receipt.
 */
function unanchor(pattern: RegExp): string {
  return pattern.source.replace(/^\^/, "").replace(/\$$/, "")
}

const FACT_ID_BODY = unanchor(FACT_ID_PATTERN)
const RECEIPT_ID_BODY = unanchor(RECEIPT_ID_PATTERN)

/** `r_xxxxxxxx.fN` (fact) or `r_xxxxxxxx` (receipt), fact tried first. */
const ANY_ID = new RegExp(`${FACT_ID_BODY}|${RECEIPT_ID_BODY}`, "g")

function receiptOf(id: string): string {
  const dot = id.indexOf(".")
  return dot === -1 ? id : id.slice(0, dot)
}

/**
 * A `[ ... ]` bracket run, so several IDs in one bracket (e.g.
 * `[r_a.f1, r_b.f2]`) and the whole-bracket span are both recognisable.
 * `start`/`end` bound the run including the brackets.
 */
type Bracket = { start: number; end: number; inner: string; innerStart: number }

const BRACKET = /\[([^\]]*)\]/g

function brackets(text: string): Bracket[] {
  const found: Bracket[] = []
  for (const match of text.matchAll(BRACKET)) {
    const start = match.index
    const inner = match[1] ?? ""
    found.push({
      start,
      end: start + match[0].length,
      inner,
      innerStart: start + 1,
    })
  }
  return found
}

/**
 * Spans of code that are excluded from every marking: fenced code blocks
 * (``` ... ```) and inline code spans (`` `...` ``). Returned sorted and
 * non-overlapping so a simple membership test suffices.
 */
function codeSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  // Fenced blocks first; their content must not be scanned for inline spans.
  const fence = /```[^\n]*\n[\s\S]*?(?:```|$)/g
  for (const match of text.matchAll(fence)) {
    spans.push({ start: match.index, end: match.index + match[0].length })
  }
  const covered = (index: number): boolean =>
    spans.some((span) => index >= span.start && index < span.end)
  // Inline spans: one or more backticks, matched by equal-length runs.
  const inline = /(`+)(?:[^`]|[^`][\s\S]*?[^`])?\1/g
  for (const match of text.matchAll(inline)) {
    const start = match.index
    if (covered(start)) continue
    spans.push({ start, end: start + match[0].length })
  }
  return spans.toSorted((a, b) => a.start - b.start)
}

function inSpans(
  index: number,
  spans: readonly { start: number; end: number }[]
): boolean {
  return spans.some((span) => index >= span.start && index < span.end)
}

/**
 * Every fact and receipt citation in `text`, in document order. Code spans and
 * fenced code blocks are excluded. Several IDs inside one `[ ... ]` bracket are
 * each returned. A bare `r_xxxxxxxx` outside a fact ID is a receipt citation;
 * `r_xxxxxxxx.fN` is a fact citation whose `receiptId` is the `r_xxxxxxxx` part.
 */
export function extractCitations(text: string): Citation[] {
  const code = codeSpans(text)
  const citations: Citation[] = []
  for (const bracket of brackets(text)) {
    if (inSpans(bracket.start, code)) continue
    for (const match of bracket.inner.matchAll(ANY_ID)) {
      const id = match[0]
      const start = bracket.innerStart + match.index
      const kind = FACT_ID_PATTERN.test(id) ? "fact" : "receipt"
      citations.push({
        kind,
        id,
        receiptId: receiptOf(id),
        start,
        end: start + id.length,
      })
    }
  }
  return citations
}

export type UncitedNumber = {
  value: string
  start: number
  end: number
  excerpt: string
}

/**
 * A number or time token. Order matters: an ISO date-time is matched before a
 * bare date, a grouped/decimal number before a plain integer, a dotted IPv4
 * before its first group. Percent, ranges and signed values are single tokens.
 * Letters adjacent to the token are handled by a manual boundary check in
 * findUncited, so identifiers like `dat32k_060205` are not split into numbers.
 */
const NUMBER_TOKEN = new RegExp(
  [
    // ISO date with optional time, optional fractional seconds, optional Z.
    "\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?)?Z?",
    // Bare clock time HH:MM(:SS).
    "\\d{1,2}:\\d{2}(?::\\d{2})?",
    // Dotted IPv4-like address as one token.
    "\\d{1,3}(?:\\.\\d{1,3}){3}",
    // Number with comma thousands separators, optional decimal, optional sign/percent.
    "[+-]?\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?%?",
    // Plain decimal or integer, optional sign, optional percent.
    "[+-]?\\d+(?:\\.\\d+)?%?",
  ].join("|"),
  "g"
)

const IDENT_CHAR = /[A-Za-z0-9_]/

/**
 * Sentence/cell boundaries for the "before the next number in the same
 * sentence or table cell" rule. A sentence ends at `. `, `! `, `? ` or a line
 * break; a table cell ends at `|`. We never need the boundary positions
 * themselves, only whether a fact ID sits between a number and the next
 * number/boundary, so segmentation is done by scanning forward.
 */
const SEGMENT_BREAK = /[|\n]|[.!?](?=\s|$)/

/**
 * Numbers and time values in `text` that no fact ID follows before the next
 * number in the same sentence or table cell (ui-concept 4.3). Excluded: code
 * spans and fenced blocks, digits inside fact/receipt IDs, and Markdown syntax
 * (ordered-list markers and heading hashes). A fact ID may follow after a unit
 * or word ("1,204 log events [r_….f4]"); only a number or a segment break in
 * between ends the window.
 */
export function findUncited(text: string): UncitedNumber[] {
  const code = codeSpans(text)
  const idSpans = idDigitSpans(text)
  const excluded = [...code, ...idSpans].toSorted((a, b) => a.start - b.start)

  type Tok = { value: string; start: number; end: number }
  const tokens: Tok[] = []
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    const start = match.index
    const end = start + match[0].length
    if (inSpans(start, excluded)) continue
    // Manual boundary: a letter/digit/underscore immediately before or after
    // makes this part of an identifier (e.g. `dat32k`, `_060205`, `U01`), not a
    // standalone number. The token itself already absorbs internal dots,
    // commas, colons and hyphens of dates, IPs and grouped numbers.
    const before = start > 0 ? text[start - 1] : ""
    const after = end < text.length ? text[end] : ""
    if (before !== undefined && IDENT_CHAR.test(before)) continue
    if (after !== undefined && IDENT_CHAR.test(after)) continue
    if (isMarkdownSyntax(text, start, end, match[0])) continue
    tokens.push({ value: match[0], start, end })
  }

  const citations = extractCitations(text)
  const uncited: UncitedNumber[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined) continue
    const next = tokens[i + 1]
    // Window end: the next number, or the next sentence/cell break.
    const breakAt = nextBreak(text, token.end)
    const windowEnd =
      next === undefined ? breakAt : Math.min(next.start, breakAt)
    const hasFact = citations.some(
      (citation) =>
        citation.kind === "fact" &&
        citation.start >= token.end &&
        citation.end <= windowEnd
    )
    if (!hasFact) {
      uncited.push({
        value: token.value,
        start: token.start,
        end: token.end,
        excerpt: excerptAround(text, token.start, token.end),
      })
    }
  }
  return uncited
}

/** Character offset of the next sentence/cell break at or after `from`. */
function nextBreak(text: string, from: number): number {
  SEGMENT_BREAK.lastIndex = 0
  const slice = text.slice(from)
  const match = SEGMENT_BREAK.exec(slice)
  return match === null ? text.length : from + match.index
}

/** Spans covering every fact/receipt ID so their digits are never numbers. */
function idDigitSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  for (const match of text.matchAll(ANY_ID)) {
    spans.push({ start: match.index, end: match.index + match[0].length })
  }
  return spans
}

/**
 * Markdown structural numbers that are not claims: an ordered-list marker at
 * the line start (`1.` / `1)`) and ATX heading hashes. A number is list syntax
 * when it is the first non-space run of its line and is immediately followed by
 * `.` or `)` and a space.
 */
function isMarkdownSyntax(
  text: string,
  start: number,
  end: number,
  value: string
): boolean {
  if (/[.,:%+-]/.test(value) === false) {
    // Only plain integers can be a list marker; check line position.
    const lineStart = text.lastIndexOf("\n", start - 1) + 1
    const lead = text.slice(lineStart, start)
    if (/^\s*$/.test(lead)) {
      const after = text.slice(end, end + 2)
      if (/^[.)]\s/.test(after)) return true
    }
  }
  return false
}

function excerptAround(text: string, start: number, end: number): string {
  const from = text.lastIndexOf("\n", start - 1) + 1
  const lineEnd = text.indexOf("\n", end)
  const to = lineEnd === -1 ? text.length : lineEnd
  return trimExcerpt(text.slice(from, to))
}

function trimExcerpt(value: string): string {
  const collapsed = value.trim().replace(/\s+/g, " ")
  return collapsed.length <= EXCERPT_MAX
    ? collapsed
    : `${collapsed.slice(0, EXCERPT_MAX - 1)}…`
}

/**
 * Required section names (concept 7, cross-checked against the playbooks in
 * packages/agent/src/playbooks). The ticket's names match the playbooks
 * exactly, so there is no deviation to report. Frame sections wrap the chosen
 * role's core; `null` role (the agent's "auto") requires the frame only.
 */
export const ROLE_SECTIONS = {
  frame: ["Scope", "Answer", "Unknown", "Verification"],
  core: {
    engineer: ["Evidence", "Timeline", "Narrowing", "Hypotheses", "Next check"],
    team_lead: [
      "Recurring patterns",
      "Recurring vs. one-off",
      "Investigate first",
      "Improvement",
    ],
    manager: [
      "Priorities",
      "Why this order",
      "Decision needed",
      "Missing information",
    ],
  },
} as const satisfies {
  frame: readonly string[]
  core: Record<AnswerRole, readonly string[]>
}

export type SectionReport = {
  present: string[]
  missing: { section: string; part: "frame" | "core" }[]
}

/**
 * A heading or a paragraph-leading bold name introducing a section (UI-02):
 * either an ATX heading (`## Scope`) or a line that begins with `**Scope**` /
 * `__Scope__`. The captured name is compared case-insensitively and tolerant
 * of a trailing colon.
 */
const HEADING = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/
const LEADING_BOLD = /^[ \t]*(?:\*\*|__)(.+?)(?:\*\*|__)/

function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/[:：]\s*$/, "")
    .toLowerCase()
}

/** Section names recognised at the start of a line, normalised. */
function presentSectionNames(text: string): Set<string> {
  const names = new Set<string>()
  for (const rawLine of text.split("\n")) {
    const heading = HEADING.exec(rawLine)
    if (heading?.[1] !== undefined) {
      names.add(normalizeName(heading[1]))
      continue
    }
    const bold = LEADING_BOLD.exec(rawLine)
    if (bold?.[1] !== undefined) {
      names.add(normalizeName(bold[1]))
    }
  }
  return names
}

/**
 * Which required sections are present and which are missing, for the frame and
 * (when a role is given) that role's core. `role` is `null` for the agent's
 * "auto" mode, which requires the frame only. Recognition is via Markdown
 * headings and paragraph-leading bold names (UI-02), case-insensitive and
 * tolerant of a trailing colon; plain-text section lines are deliberately not
 * recognised, matching the UI's structure view.
 */
export function detectSections(
  text: string,
  role: AnswerRole | null
): SectionReport {
  const present = presentSectionNames(text)
  const report: SectionReport = { present: [], missing: [] }
  const consider = (names: readonly string[], part: "frame" | "core"): void => {
    for (const name of names) {
      if (present.has(normalizeName(name))) report.present.push(name)
      else report.missing.push({ section: name, part })
    }
  }
  consider(ROLE_SECTIONS.frame, "frame")
  if (role !== null) consider(ROLE_SECTIONS.core[role], "core")
  return report
}

/** One submitted check_claims call, in call order. */
export const submittedCheckSchema = z.object({
  receipt_id: receiptIdSchema,
  output: checkClaimsOutputSchema,
})
export type SubmittedCheck = z.infer<typeof submittedCheckSchema>

export const gateFindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no_check") }),
  z.object({
    kind: z.literal("mismatch"),
    fact: z.string(),
    mismatch_on: z.array(z.enum(["value", "metric", "group"])),
    check_receipt_id: z.string(),
    excerpt: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("unresolved"),
    fact: z.string(),
    status: z.enum(["unknown_fact", "unknown_receipt"]),
    check_receipt_id: z.string(),
    excerpt: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("unchecked"),
    fact: z.string(),
    start: z.number(),
    end: z.number(),
    excerpt: z.string(),
  }),
  z.object({
    kind: z.literal("uncited"),
    value: z.string(),
    start: z.number(),
    end: z.number(),
    excerpt: z.string(),
  }),
  z.object({
    kind: z.literal("missing_section"),
    section: z.string(),
    part: z.enum(["frame", "core"]),
  }),
])
export type GateFinding = z.infer<typeof gateFindingSchema>

/** The latest claim result for one fact ID across all checks, in call/claim order. */
type LatestClaim = {
  receiptId: string
  status: "verified" | "mismatch" | "unknown_fact" | "unknown_receipt"
  mismatchOn: ("value" | "metric" | "group")[]
}

/**
 * Collapses every submitted claim to the latest result per fact ID string
 * (checks in order, claims in order). A later verified re-submission supersedes
 * an earlier mismatch; the last check that mentions the fact wins, and within
 * that check any non-verified claim for the fact makes it a finding.
 */
function latestByFact(
  checks: readonly SubmittedCheck[]
): Map<string, LatestClaim> {
  const latest = new Map<string, LatestClaim>()
  // Track which check index last touched each fact, so results from an earlier
  // check never override a later one even when the later check verifies it.
  const lastCheckIndex = new Map<string, number>()
  checks.forEach((check, checkIndex) => {
    for (const result of check.output.claims) {
      const fact = result.claim.fact
      const seenIndex = lastCheckIndex.get(fact)
      if (seenIndex !== undefined && seenIndex < checkIndex) {
        // A new, later check mentions this fact: reset to this check's view.
        latest.set(fact, {
          receiptId: check.receipt_id,
          status: result.status,
          mismatchOn: [...result.mismatch_on],
        })
        lastCheckIndex.set(fact, checkIndex)
        continue
      }
      const current = latest.get(fact)
      if (
        current === undefined ||
        seenIndex === undefined ||
        seenIndex < checkIndex
      ) {
        latest.set(fact, {
          receiptId: check.receipt_id,
          status: result.status,
          mismatchOn: [...result.mismatch_on],
        })
        lastCheckIndex.set(fact, checkIndex)
        continue
      }
      // Same check: a non-verified claim for the fact wins over a verified one.
      if (current.status === "verified" && result.status !== "verified") {
        latest.set(fact, {
          receiptId: check.receipt_id,
          status: result.status,
          mismatchOn: [...result.mismatch_on],
        })
      }
    }
  })
  return latest
}

/** The excerpt (sentence/cell) of the final text that cites `fact`, or null. */
function citingExcerpt(
  text: string,
  citations: readonly Citation[],
  fact: string
): string | null {
  const citation = citations.find((item) => item.id === fact)
  if (citation === undefined) return null
  return excerptAround(text, citation.start, citation.end)
}

/**
 * The deterministic gate findings over the final answer and all check_claims
 * results (technical.md § 11). Order: no_check, then per-fact mismatch and
 * unresolved findings in first-citation order, then unchecked (document order),
 * then uncited (document order), then missing sections (frame before core, in
 * ROLE_SECTIONS order). This module never checks a value itself — the mismatch
 * and unresolved findings come straight from the submitted check_claims
 * results (§ 8.3).
 *
 * `unchecked` rule: a fact citation is unchecked when it appears in no
 * submitted check_claims claim — EXCEPT the summary facts of a submitted
 * check_claims receipt itself. The Verification line cites a check's own
 * summary (e.g. `N claims checked [r_….f1] · M mismatch [r_….f2] · K
 * unresolved [r_….f3]`), and common.md states these summary facts come
 * directly from that check and are deliberately not re-submitted to it. So a
 * fact whose receipt ID is one of the submitted checks' receipt IDs is exempt
 * from `unchecked`, while a fact from any other, unsubmitted receipt (even a
 * check_claims-shaped one that was never submitted here) is still `unchecked`.
 */
export function answerFindings(input: {
  text: string
  role: AnswerRole | null
  checks: SubmittedCheck[]
}): GateFinding[] {
  const { text, role, checks } = input
  if (checks.length === 0) return [{ kind: "no_check" }]

  const findings: GateFinding[] = []
  const citations = extractCitations(text)
  const latest = latestByFact(checks)

  // Fact citations in the text, in document order, de-duplicated by first use.
  const citedFactsInOrder: string[] = []
  const seenFact = new Set<string>()
  for (const citation of citations) {
    if (citation.kind !== "fact") continue
    if (seenFact.has(citation.id)) continue
    seenFact.add(citation.id)
    citedFactsInOrder.push(citation.id)
  }

  // mismatch / unresolved: per fact, its latest result if not verified. Ordered
  // by first citation in the text; facts checked but never cited follow, in the
  // order their latest check lists them.
  const reported = new Set<string>()
  const emitFact = (fact: string): void => {
    if (reported.has(fact)) return
    const result = latest.get(fact)
    if (result === undefined || result.status === "verified") return
    reported.add(fact)
    const excerpt = citingExcerpt(text, citations, fact)
    if (result.status === "mismatch") {
      findings.push({
        kind: "mismatch",
        fact,
        mismatch_on: result.mismatchOn,
        check_receipt_id: result.receiptId,
        excerpt,
      })
    } else {
      findings.push({
        kind: "unresolved",
        fact,
        status: result.status,
        check_receipt_id: result.receiptId,
        excerpt,
      })
    }
  }
  for (const fact of citedFactsInOrder) emitFact(fact)
  for (const fact of latest.keys()) emitFact(fact)

  // unchecked: fact citations in the text that appear in no submitted claim.
  // Facts of a submitted check_claims receipt itself (its summary counts, cited
  // by the Verification line) come directly from that check and are never
  // re-submitted (common.md), so they are not unchecked.
  const submittedFacts = new Set<string>()
  const checkReceipts = new Set<string>()
  for (const check of checks) {
    checkReceipts.add(check.receipt_id)
    for (const result of check.output.claims)
      submittedFacts.add(result.claim.fact)
  }
  for (const citation of citations) {
    if (citation.kind !== "fact") continue
    if (submittedFacts.has(citation.id)) continue
    if (checkReceipts.has(citation.receiptId)) continue
    findings.push({
      kind: "unchecked",
      fact: citation.id,
      start: citation.start,
      end: citation.end,
      excerpt: excerptAround(text, citation.start, citation.end),
    })
  }

  // uncited: numbers/times with no following fact ID.
  for (const number of findUncited(text)) {
    findings.push({
      kind: "uncited",
      value: number.value,
      start: number.start,
      end: number.end,
      excerpt: number.excerpt,
    })
  }

  // missing sections: frame before core, in ROLE_SECTIONS order.
  for (const missing of detectSections(text, role).missing) {
    findings.push({
      kind: "missing_section",
      section: missing.section,
      part: missing.part,
    })
  }

  return findings
}

/**
 * A deterministic English feedback line per finding (technical.md § 11,
 * ui-concept 4.3: `findingsFeedback` drives the agent's one revision). One line
 * per finding, in `answerFindings` order; `""` when there are no findings.
 */
export function findingsFeedback(findings: GateFinding[]): string {
  return findings.map(feedbackLine).join("\n")
}

function quoteExcerpt(excerpt: string | null): string {
  return excerpt === null ? "" : `Sentence "${excerpt}": `
}

function feedbackLine(finding: GateFinding): string {
  switch (finding.kind) {
    case "no_check":
      return "No check_claims call was made. Submit every number and time you state with check_claims before answering."
    case "mismatch":
      return `${quoteExcerpt(finding.excerpt)}fact ${finding.fact} mismatch on ${finding.mismatch_on.join(", ")}. Correct the claim or remove it.`
    case "unresolved": {
      const reason =
        finding.status === "unknown_receipt"
          ? "its receipt is unknown"
          : "it resolves to no fact"
      return `${quoteExcerpt(finding.excerpt)}fact ${finding.fact} is unresolved (${reason}). Cite a real fact ID or remove the claim.`
    }
    case "unchecked":
      return `Sentence "${finding.excerpt}": fact ${finding.fact} was not submitted to check_claims. Submit it or remove the number.`
    case "uncited":
      return `Sentence "${finding.excerpt}": the number ${finding.value} has no fact ID. Add the fact ID it comes from or remove it.`
    case "missing_section":
      return `Missing section: ${finding.section}. Add the ${finding.part === "frame" ? "frame" : "role core"} section "${finding.section}".`
  }
}
