import { Database } from "lucide-react"
import type { ToolOutcome } from "@workspace/domain/tool"
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@workspace/ui/components/card"
import { Badge } from "@workspace/ui/components/badge"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@workspace/ui/components/collapsible"
import { Button } from "@workspace/ui/components/button"
import { ReceiptLink } from "@/components/evidence/ReceiptLink"
import { receiptFeatures } from "@/components/evidence/features"
import { ToolErrorNotice } from "@/components/workspace/ToolErrorNotice"
import { EventTimeline } from "@/components/charts/EventTimeline"
import { ResultPreview } from "./ResultPreview"
import { ResultView } from "./ResultView"
export function ToolPanel({
  title,
  description,
  outcome,
}: {
  title: string
  description?: string
  outcome: ToolOutcome<unknown>
}) {
  return (
    <Card className="min-w-0 shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        {!outcome.ok ? (
          <ToolErrorNotice error={outcome.error} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <ReceiptLink id={outcome.result.receipt.receipt_id} />
              <span className="text-xs text-muted-foreground">
                SereneDB {outcome.result.receipt.duration_ms} ms
              </span>
              {receiptFeatures(outcome.result.receipt.sql).map((feature) => (
                <Badge
                  key={feature.label}
                  variant="secondary"
                  title={feature.description}
                >
                  {feature.label}
                </Badge>
              ))}
              {outcome.result.receipt.truncated && (
                <Badge variant="outline">Truncated</Badge>
              )}
            </div>
            {title.includes("weekly error trend") && (
              <EventTimeline result={outcome.result} />
            )}
            <ResultPreview result={outcome.result} />
            <Collapsible>
              <CollapsibleTrigger
                render={<Button variant="outline" size="sm" />}
              >
                Full result & caveats
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-4 max-h-[36rem] space-y-4 overflow-auto">
                {outcome.result.notes.map((note) => (
                  <p
                    key={note}
                    className="text-xs leading-5 text-muted-foreground"
                  >
                    {note}
                  </p>
                ))}
                <ResultView
                  value={outcome.result.data}
                  facts={outcome.result.facts}
                  receiptId={outcome.result.receipt.receipt_id}
                />
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
      </CardContent>
    </Card>
  )
}
