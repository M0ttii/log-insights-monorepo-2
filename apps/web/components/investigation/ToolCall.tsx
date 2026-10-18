import { memo, useMemo } from "react"
import { z } from "zod"
import { Check, CircleDashed, LoaderCircle, XCircle } from "lucide-react"
import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai"
import { Badge } from "@workspace/ui/components/badge"
import {
  CodeBlock,
  CodeBlockContent,
} from "@workspace/ui/components/code-block"
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@workspace/ui/components/trace"
import { ReceiptLink } from "../evidence/ReceiptLink"
import { receiptFeatures } from "../evidence/features"
import { ResultView } from "../results/ResultView"
import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@workspace/ui/components/alert"
import { outcomeSchema } from "./mapper"
import { CheckSummary } from "./Verification"
import type { Interruption } from "./types"

function toolState(
  failed: boolean,
  complete: boolean,
  interruption?: Interruption
) {
  if (failed) return { label: "Failed", icon: XCircle }
  if (complete) return { label: "Complete", icon: Check }
  if (interruption)
    return {
      label: interruption === "stopped" ? "Stopped" : "Interrupted",
      icon: CircleDashed,
    }
  return { label: "Running", icon: LoaderCircle }
}

export const ToolCall = memo(function ToolCall({
  part,
  interruption,
}: {
  part: ToolUIPart | DynamicToolUIPart
  interruption?: Interruption
}) {
  const name = getToolName(part)
  const value = "output" in part ? part.output : undefined
  const output = useMemo(
    () => (value === undefined ? null : outcomeSchema.safeParse(value)),
    [value]
  )
  const outcome = output?.success ? output.data : null
  const result = outcome?.ok ? outcome.result : null
  const features = useMemo(
    () => (result ? receiptFeatures(result.receipt.sql) : []),
    [result]
  )
  const failed =
    part.state === "output-error" ||
    part.state === "output-denied" ||
    outcome?.ok === false
  const complete = part.state === "output-available"
  const running = !complete && !failed && !interruption
  const state = toolState(failed, complete, interruption)
  const Icon = state.icon
  const input = useMemo(
    () => z.record(z.string(), z.unknown()).safeParse(part.input),
    [part.input]
  )
  const mode =
    input.success && typeof input.data.mode === "string"
      ? input.data.mode
      : null
  const label =
    name === "get_log_context" && mode === "aggregate"
      ? "Precursor analysis"
      : name === "count_events" && input.success && input.data.compare
        ? "Period comparison"
        : name === "recurring_patterns" &&
            input.success &&
            input.data.rank === "investigation_order"
          ? "Investigation order"
          : name.replaceAll("_", " ")
  const summary = input.success
    ? ["query", "mode", "dataset", "from", "to", "group_by"]
        .flatMap((key) => {
          const field = input.data[key]
          if (typeof field === "string") return [field]
          if (
            Array.isArray(field) &&
            field.every((item) => typeof item === "string")
          )
            return [field.join(", ")]
          return []
        })
        .join(" · ")
    : ""
  return (
    <Trace>
      <TraceCollapsible>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <TraceCollapsibleTrigger>
            <TraceLine
              status={failed ? "error" : running ? "running" : undefined}
            >
              <TraceIcon>
                <Icon
                  className={running ? "motion-safe:animate-spin" : undefined}
                />
              </TraceIcon>
              <TraceTitle className="font-mono">{name}</TraceTitle>
              <TraceDescription className="text-xs text-muted-foreground">
                {label !== name.replaceAll("_", " ") ? `${label} · ` : ""}
                {state.label}
              </TraceDescription>
            </TraceLine>
          </TraceCollapsibleTrigger>
          {result && (
            <>
              <span className="text-xs text-muted-foreground">
                SereneDB {result.receipt.duration_ms} ms
              </span>
              <ReceiptLink id={result.receipt.receipt_id} />
              {features.slice(0, 3).map((feature) => (
                <Badge
                  key={feature.label}
                  variant="secondary"
                  title={feature.description}
                >
                  {feature.label}
                </Badge>
              ))}
              {result.receipt.truncated && (
                <Badge variant="outline">Truncated</Badge>
              )}
            </>
          )}
        </div>
        {summary && (
          <p
            className="mt-1 truncate pl-6 text-xs text-muted-foreground"
            title={summary}
          >
            {summary}
          </p>
        )}
        {name === "check_claims" && result && !interruption && (
          <div className="mt-2 pl-6 text-muted-foreground">
            <CheckSummary result={result} />
          </div>
        )}
        <TraceCollapsibleContent className="mt-3 ml-2 max-h-96 min-w-0 space-y-4 overflow-auto border-l pl-5">
          <section aria-label="Tool input">
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">
              Input
            </h3>
            <CodeBlock size="sm">
              <CodeBlockContent
                className="max-h-64"
                aria-label="Tool input JSON"
              >
                {JSON.stringify(
                  result?.receipt.input ?? part.input ?? {},
                  null,
                  2
                )}
              </CodeBlockContent>
            </CodeBlock>
          </section>
          {outcome?.ok === false && (
            <Alert>
              <XCircle />
              <AlertTitle>
                {outcome.error.code} · {outcome.error.message}
              </AlertTitle>
              <AlertDescription>{outcome.error.hint}</AlertDescription>
            </Alert>
          )}
          {failed && outcome?.ok !== false && (
            <p className="text-sm text-muted-foreground">
              The tool could not complete. Narrow the scope and try again.
            </p>
          )}
          {result && (
            <>
              <div className="flex flex-wrap gap-2">
                {features.map((feature) => (
                  <Badge
                    key={feature.label}
                    variant="secondary"
                    title={feature.description}
                  >
                    {feature.label}
                  </Badge>
                ))}
              </div>
              {result.notes.map((note) => (
                <p
                  key={note}
                  className="text-xs leading-5 text-muted-foreground"
                >
                  {note}
                </p>
              ))}
              <ResultView
                value={result.data}
                facts={result.facts}
                receiptId={result.receipt.receipt_id}
              />
            </>
          )}
          {complete && !outcome && (
            <p className="text-sm text-muted-foreground">
              Result format unavailable. No verification is inferred.
            </p>
          )}
          {running && (
            <p className="text-xs text-muted-foreground">
              Waiting for the tool result…
            </p>
          )}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
})
