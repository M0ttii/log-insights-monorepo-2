import { getToolName, isToolUIPart, type UIMessage } from "ai"
import { z } from "zod"
import {
  gateFindingSchema,
  type GateFinding,
  type SubmittedCheck,
} from "@workspace/domain/answer"
import { toolResultSchema } from "@workspace/domain/tool"
import { toolErrorSchema } from "@workspace/domain/errors"
import { checkClaimsOutputSchema } from "@workspace/domain/tools/check-claims"

const successSchema = z.object({
  ok: z.literal(true),
  result: toolResultSchema(z.unknown()),
})
const adapterErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    error: z.object({
      kind: z.enum([
        "invalid_input",
        "not_found",
        "query_timeout",
        "db_unavailable",
        "receipt_unavailable",
        "limit_exceeded",
        "source_changed",
      ]),
      message: z.string(),
      hint: z.string(),
    }),
  }),
})
export const outcomeSchema = z.union([
  successSchema,
  z.object({ ok: z.literal(false), error: toolErrorSchema }),
  adapterErrorSchema.transform((value) => ({
    ok: value.ok,
    error: {
      code: value.error.error.kind,
      message: value.error.error.message,
      hint: value.error.error.hint,
    },
  })),
])

const phaseSchema = z.object({
  kind: z.enum(["preflight", "investigate", "answer", "revise"]),
  draft: z.enum(["draft", "final"]),
  requirement: z.string().min(1).max(1000).optional(),
})
const gateSchema = z.object({
  version: z.enum(["draft", "final"]),
  findings: z.array(gateFindingSchema),
})
const nullableTokens = z.number().nonnegative().nullable()
const runSchema = z.object({
  run_id: z.string().regex(/^run_[a-f0-9]{8}$/),
  status: z.enum(["completed", "stopped", "refusal", "error", "timeout"]),
  duration_ms: z.number().nonnegative(),
  usage: z.object({
    input: nullableTokens,
    output: nullableTokens,
    cache_read: nullableTokens,
    cache_write: nullableTokens,
  }),
})
export type PublicRun = z.infer<typeof runSchema>
type Part = UIMessage["parts"][number]

/** Parse-and-project strips any unexpected provider or instruction fields. */
export function publicDataPart(part: Part) {
  if (part.type === "data-phase") {
    const parsed = phaseSchema.safeParse(part.data)
    return parsed.success ? { type: part.type, data: parsed.data } : null
  }
  if (part.type === "data-gate") {
    const parsed = gateSchema.safeParse(part.data)
    return parsed.success ? { type: part.type, data: parsed.data } : null
  }
  if (part.type === "data-run") {
    const parsed = runSchema.safeParse(part.data)
    return parsed.success ? { type: part.type, data: parsed.data } : null
  }
  return null
}

/** Read only public parts. Phase boundaries, rather than text heuristics, split versions. */
export function projectMessage(message: UIMessage) {
  const tools: Part[] = []
  const draft: Part[] = []
  const final: Part[] = []
  const checks: SubmittedCheck[] = []
  let draftChecks: SubmittedCheck[] = []
  let phase: z.infer<typeof phaseSchema> | null = null
  let run: PublicRun | null = null
  let revised = false
  let investigations = 0
  let draftFindings: GateFinding[] = []
  for (const part of message.parts) {
    if (part.type === "data-phase") {
      const parsed = phaseSchema.safeParse(part.data)
      if (!parsed.success) continue
      phase = parsed.data
      if (phase.kind === "investigate") {
        investigations += 1
        if (investigations > 1)
          tools.push({ type: "data-phase", data: parsed.data })
      }
      if (phase.kind === "revise") {
        revised = true
        draftChecks = [...checks]
      }
      continue
    }
    if (part.type === "data-gate") {
      const parsed = gateSchema.safeParse(part.data)
      if (parsed.success && parsed.data.version === "draft")
        draftFindings = parsed.data.findings
      continue
    }
    if (part.type === "data-run") {
      const parsed = runSchema.safeParse(part.data)
      if (parsed.success) run = parsed.data
      continue
    }
    if (isToolUIPart(part)) {
      if (getToolName(part) === "check_claims" && "output" in part) {
        const outcome = outcomeSchema.safeParse(part.output)
        if (outcome.success && outcome.data.ok) {
          const check = checkClaimsOutputSchema.safeParse(
            outcome.data.result.data
          )
          if (check.success)
            checks.push({
              receipt_id: outcome.data.result.receipt.receipt_id,
              output: check.data,
            })
        }
      }
      if (phase?.kind === "revise") final.push(part)
      else if (phase?.kind === "answer") draft.push(part)
      else tools.push(part)
    } else if (part.type === "text") {
      // Investigation text is transient progress, not the agent's answer.
      if (phase?.kind === "revise") final.push(part)
      else if (phase === null || phase.kind === "answer") draft.push(part)
    }
  }
  return {
    tools,
    draft: revised ? draft : [],
    final: revised ? final : draft,
    checks,
    draftChecks: revised ? draftChecks : checks,
    draftFindings,
    revised,
    run,
    phase,
  }
}

export function requestedEvidence(part: Part): string | null {
  if (part.type !== "data-phase") return null
  const parsed = phaseSchema.safeParse(part.data)
  return parsed.success && parsed.data.kind === "investigate"
    ? (parsed.data.requirement ?? null)
    : null
}

export function textOf(parts: readonly Part[]): string {
  return parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n")
}

export function findingText(finding: GateFinding): string {
  switch (finding.kind) {
    case "no_check":
      return "No claim check was completed"
    case "mismatch":
      return `Mismatch on ${finding.fact} (${finding.mismatch_on.join(", ")})`
    case "unresolved":
      return `Unresolved fact ${finding.fact}`
    case "unchecked":
      return `Unchecked fact ${finding.fact}`
    case "uncited":
      return `Number without a fact ID: ${finding.value}`
    case "missing_section":
      return `Missing section: ${finding.section}`
  }
}

/** Keep history requests bounded: results live in server receipts and run records. */
export function requestMessages(messages: UIMessage[]) {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      id: message.id,
      role: message.role,
      parts:
        message.role === "user"
          ? message.parts
              .filter((part) => part.type === "text")
              .map((part) => ({ type: part.type, text: part.text }))
          : message.parts.flatMap((part) => {
              if (part.type !== "data-run") return []
              const parsed = runSchema.safeParse(part.data)
              return parsed.success
                ? [{ type: "data-run", data: parsed.data }]
                : []
            }),
    }))
}
