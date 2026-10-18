import { isToolUIPart, getToolName, type UIMessage } from "ai"
import {
  answerFindings,
  extractCitations,
  findUncited,
  type AnswerRole,
  type SubmittedCheck,
} from "@workspace/domain/answer"
import { checkClaimsOutputSchema } from "@workspace/domain/tools/check-claims"
import { ReceiptLink } from "../evidence/ReceiptLink"
import { outcomeSchema } from "./mapper"

export function CheckSummary({
  result,
}: {
  result: {
    data: unknown
    facts: { id: string; path: string }[]
    receipt: { receipt_id: string }
  }
}) {
  const output = checkClaimsOutputSchema.safeParse(result.data)
  if (!output.success) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs leading-6">
      <span>{output.data.summary.text}</span>
      {result.facts
        .filter((fact) => fact.path.startsWith("/result/summary/"))
        .map((fact) => (
          <ReceiptLink
            key={fact.id}
            id={result.receipt.receipt_id}
            fact={fact.id}
            status="verified"
          />
        ))}
    </div>
  )
}

export function Verification({
  text,
  role,
  checks,
  parts,
}: {
  text: string
  role: AnswerRole | null
  checks: SubmittedCheck[]
  parts: UIMessage["parts"]
}) {
  const findings = answerFindings({ text, role, checks })
  const unchecked =
    checks.length === 0
      ? extractCitations(text).filter((citation) => citation.kind === "fact")
          .length
      : findings.filter((finding) => finding.kind === "unchecked").length
  const uncited = findUncited(text).length
  const calls = parts
    .filter(isToolUIPart)
    .filter((part) => getToolName(part) === "check_claims")
  return (
    <section
      aria-label="Claim verification"
      className="space-y-3 rounded-lg border border-(--conclusion-border) bg-(--conclusion-background) p-4"
    >
      <h3 className="text-sm font-medium">Verification</h3>
      {checks.length === 0 ? (
        <p className="text-xs text-muted-foreground">Not verified</p>
      ) : (
        calls.map((part) => {
          const parsed = outcomeSchema.safeParse(
            "output" in part ? part.output : null
          )
          return parsed.success && parsed.data.ok ? (
            <div key={part.toolCallId}>
              <p className="mb-1 font-mono text-xs text-muted-foreground">
                check_claims · {parsed.data.result.receipt.receipt_id}
              </p>
              <CheckSummary result={parsed.data.result} />
            </div>
          ) : null
        })
      )}
      <p className="border-t pt-3 text-xs leading-5 text-muted-foreground">
        Markings: {unchecked} unchecked fact IDs · {uncited} uncited numbers.
        Claim checks verify submitted values, metrics and groups; explanations
        are not verified.
      </p>
    </section>
  )
}
