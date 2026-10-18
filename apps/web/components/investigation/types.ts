import type { AnswerRole } from "@workspace/domain/answer"
import type { Filter } from "@workspace/domain/filters"

/** UI provenance for incomplete messages; useChat owns all live request state. */
export type Interruption = "stopped" | "failed"
export type RunContext = {
  question: string
  role: AnswerRole
  scope: Filter
}
