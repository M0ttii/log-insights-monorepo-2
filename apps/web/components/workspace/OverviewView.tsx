import Link from "next/link"
import { ArrowRight, Clock3, Database } from "lucide-react"
import type { ToolOutcome } from "@workspace/domain/tool"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { buttonVariants } from "@workspace/ui/components/button"
import { ToolPanel } from "@/components/results/ToolPanel"
import { ReceiptLink } from "@/components/evidence/ReceiptLink"
import { ToolErrorNotice } from "./ToolErrorNotice"
import { formatUtcDate } from "./format"
import { DATASETS } from "@workspace/domain/datasets"
import { datasetTitle, loadedDatasetIds } from "@/components/datasets/catalog"
const panels = [
  {
    title: "Events by dataset and team",
    description: "Totals over each dataset’s full span.",
  },
  {
    title: "Error events by dataset and team",
    description: "Error levels as defined by the shared rules.",
  },
  {
    title: "BGL · weekly error trend",
    description:
      "UTC buckets. Partial buckets and capture gaps remain explicit.",
  },
  {
    title: "BGL · recurring patterns",
    description: "Ordered by episodes, as returned by SereneDB.",
  },
  {
    title: "OpenStack · recurring patterns",
    description: "Ordered by episodes, as returned by SereneDB.",
  },
  {
    title: "OpenStack · API latency and error rates",
    description:
      "API access events, unique requests, percentiles, and rate denominators.",
  },
]
export function OverviewView({
  outcomes,
}: {
  outcomes: ToolOutcome<unknown>[]
}) {
  const corpus = outcomes[0]
  return (
    <div className="workspace-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="page-heading">Corpus overview</h1>
          <p className="page-description">
            The shape of your data, directly from SereneDB.
          </p>
        </div>
        <Link
          className={buttonVariants({ variant: "outline", size: "sm" })}
          href="/logs"
        >
          Explore logs
          <ArrowRight />
        </Link>
      </div>
      <p className="mt-6 flex items-start gap-2 text-xs leading-5 text-muted-foreground">
        <Clock3 className="mt-0.5 size-3.5 shrink-0" />
        Each dataset has its own time axis. Cross-dataset counts cover the
        loaded log corpus over each full span. OTel and OTLP replay require
        explicit selection and are excluded from those totals.
      </p>
      {corpus && !corpus.ok && (
        <div className="mt-6">
          <ToolErrorNotice error={corpus.error} />
        </div>
      )}
      {corpus?.ok && (
        <section
          className="mt-6 grid gap-4 lg:grid-cols-2"
          aria-label="Loaded datasets"
        >
          {loadedDatasetIds(corpus).map((dataset) => {
            const facts = corpus.result.facts.filter(
              (fact) => fact.group.dataset === dataset
            )
            const events = facts.find(
              (fact) =>
                fact.metric === "events" &&
                /\/datasets\/\d+\/events$/.test(fact.path)
            )
            const first = facts.find((fact) =>
              fact.path.endsWith("/first_event")
            )
            const last = facts.find((fact) => fact.path.endsWith("/last_event"))
            return (
              <Card key={dataset} className="shadow-none">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Database className="size-4 text-link" />
                    {datasetTitle(dataset)}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {DATASETS[dataset].storage === "remote_parquet" ? (
                    <p className="text-sm text-muted-foreground">
                      External Parquet rows. Full text covers the indexed
                      reference window; direct scans are bounded. See Corpus for
                      sources and limits.
                    </p>
                  ) : (
                    <p className="flex flex-wrap items-baseline gap-2">
                      <strong className="text-2xl font-semibold tabular-nums">
                        {events
                          ? Number(events.value).toLocaleString("en-US")
                          : "Unknown"}
                      </strong>
                      <span className="text-sm text-muted-foreground">
                        {DATASETS[dataset].storage === "otlp_replay"
                          ? "replayed log events · not a production stream"
                          : "log events"}
                      </span>
                      {events && (
                        <ReceiptLink
                          id={corpus.result.receipt.receipt_id}
                          fact={events.id}
                        />
                      )}
                    </p>
                  )}
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {first && (
                      <>
                        <span>{formatUtcDate(String(first.value))}</span>
                        <ReceiptLink
                          id={corpus.result.receipt.receipt_id}
                          fact={first.id}
                        />
                      </>
                    )}
                    <span>–</span>
                    {last && (
                      <>
                        <span>{formatUtcDate(String(last.value))} UTC</span>
                        <ReceiptLink
                          id={corpus.result.receipt.receipt_id}
                          fact={last.id}
                        />
                      </>
                    )}
                  </p>
                  <Link
                    className={buttonVariants({ variant: "ghost", size: "sm" })}
                    href={`/logs?dataset=${dataset}`}
                  >
                    Search {datasetTitle(dataset)}
                    <ArrowRight />
                  </Link>
                </CardContent>
              </Card>
            )
          })}
        </section>
      )}
      <section
        className="mt-8 grid items-start gap-5 lg:grid-cols-2"
        aria-label="Corpus analytics"
      >
        {panels.map((panel, index) => {
          const outcome = outcomes[index + 1]
          return outcome ? (
            <ToolPanel key={panel.title} {...panel} outcome={outcome} />
          ) : null
        })}
      </section>
    </div>
  )
}
