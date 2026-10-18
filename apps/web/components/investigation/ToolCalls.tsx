import { memo } from "react"
import { isToolUIPart, type UIMessage } from "ai"
import {
  Check,
  ChevronRight,
  CircleDashed,
  LoaderCircle,
  XCircle,
} from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import { toolFailureSchema, requestedEvidence } from "./mapper"
import { ToolCall } from "./ToolCall"
import type { Interruption } from "./types"

function groupState(
  pending: boolean,
  failed: boolean,
  interruption?: Interruption
) {
  if (pending) {
    if (!interruption) return { label: "Running", icon: LoaderCircle }
    return {
      label: interruption === "stopped" ? "Stopped" : "Interrupted",
      icon: CircleDashed,
    }
  }
  if (failed) return { label: null, icon: XCircle }
  return { label: "Complete", icon: Check }
}

export const ToolCalls = memo(function ToolCalls({
  parts,
  interruption,
  open,
  onOpenChange,
}: {
  parts: UIMessage["parts"]
  interruption?: Interruption
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const calls = parts.filter(isToolUIPart)
  const failed = calls.filter((part) => {
    if (part.state === "output-error" || part.state === "output-denied")
      return true
    return toolFailureSchema.safeParse(
      "output" in part ? part.output : undefined
    ).success
  }).length
  const pending = calls.some(
    (part) =>
      !["output-available", "output-error", "output-denied"].includes(
        part.state
      )
  )
  const running = pending && !interruption
  const state = groupState(pending, failed > 0, interruption)
  const status = [state.label, failed > 0 ? `${failed} failed` : null]
    .filter(Boolean)
    .join(" · ")
  const Icon = state.icon
  const rows = parts.map((part, index) => {
    if (isToolUIPart(part))
      return (
        <ToolCall
          key={part.toolCallId}
          part={part}
          interruption={interruption}
        />
      )
    if (part.type !== "data-phase") return null
    const requirement = requestedEvidence(part)
    return (
      <p key={index} className="text-xs wrap-anywhere text-muted-foreground">
        Required evidence requested{requirement ? `: ${requirement}` : ""}
      </p>
    )
  })
  // Keep coverage reminders visible even before a tool has been requested.
  if (calls.length === 0) return <>{rows}</>
  return (
    <Collapsible
      className="min-w-0"
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
    >
      <CollapsibleTrigger
        render={<Button variant="ghost" size="sm" />}
        className="group h-auto min-h-8 max-w-full flex-wrap justify-start gap-2 px-2 py-1.5 text-left text-xs whitespace-normal text-muted-foreground"
      >
        <Icon
          aria-hidden="true"
          className={running ? "size-3.5 motion-safe:animate-spin" : "size-3.5"}
        />
        <span>
          {calls.length} tool {calls.length === 1 ? "call" : "calls"}
        </span>
        <span>{status}</span>
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 min-w-0 space-y-5 pl-2">
        {rows}
      </CollapsibleContent>
    </Collapsible>
  )
})
