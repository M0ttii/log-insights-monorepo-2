import { z } from "zod"
import type { ToolResult } from "@workspace/domain/tool"
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@workspace/ui/components/card"
import { Button } from "@workspace/ui/components/button"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@workspace/ui/components/collapsible"
import { ResultView } from "@/components/results/ResultView"
const summaryKeys = [
  "storage",
  "counts_cover",
  "events",
  "lines_read",
  "rejected",
  "error_events",
  "patterns",
  "first_event",
  "last_event",
]
const detailKeys = [
  "fields",
  "levels",
  "components",
  "labels",
  "api_accesses",
  "api_accesses_without_request_id",
  "requests",
  "time_basis",
  "label_source",
  "capabilities",
  "remote",
  "replay",
]
export function DatasetCards({
  datasets,
  result,
}: {
  datasets: unknown
  result: ToolResult<unknown>
}) {
  const parsed = z.array(z.record(z.string(), z.unknown())).safeParse(datasets)
  if (!parsed.success) return <p>Dataset metadata unavailable.</p>
  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      {parsed.data.map((dataset, index) => (
        <Card key={String(dataset.dataset)} className="min-w-0 shadow-none">
          <CardHeader>
            <CardTitle className="text-base [overflow-wrap:anywhere]">
              {typeof dataset.title === "string"
                ? dataset.title
                : String(dataset.dataset)}
            </CardTitle>
          </CardHeader>
          <CardContent className="min-w-0 space-y-5">
            {dataset.counts_cover === "reference_window" && (
              <p className="text-sm leading-6 text-muted-foreground">
                Error counts, levels, components, and field statistics cover the
                indexed reference window only. Parquet footer counts include
                boundary duplicates and are not distinct events.
              </p>
            )}
            {dataset.storage === "otlp_replay" && (
              <p className="text-sm leading-6 text-muted-foreground">
                Bounded OTLP replay of public records, not a production stream.
                Tools read its recorded index snapshot.
              </p>
            )}
            <dl className="divide-y">
              {summaryKeys.map((key) => (
                <div
                  key={key}
                  className="grid gap-1 py-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]"
                >
                  <dt className="text-xs text-muted-foreground capitalize">
                    {key.replaceAll("_", " ")}
                  </dt>
                  <dd className="min-w-0">
                    <ResultView
                      value={dataset[key]}
                      facts={result.facts}
                      receiptId={result.receipt.receipt_id}
                      path={`/result/datasets/${index}/${key}`}
                    />
                  </dd>
                </div>
              ))}
            </dl>
            <Collapsible>
              <CollapsibleTrigger
                render={<Button variant="outline" size="sm" />}
              >
                Schema, labels & details
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-4 max-h-96 space-y-5 overflow-auto">
                {detailKeys
                  .filter((key) =>
                    key === "remote" || key === "replay"
                      ? dataset[key] != null
                      : true
                  )
                  .map((key) => (
                    <section key={key} className="min-w-0">
                      <h3 className="mb-2 text-sm font-medium capitalize">
                        {key.replaceAll("_", " ")}
                      </h3>
                      <ResultView
                        value={dataset[key]}
                        facts={result.facts}
                        receiptId={result.receipt.receipt_id}
                        path={`/result/datasets/${index}/${key}`}
                      />
                    </section>
                  ))}
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
