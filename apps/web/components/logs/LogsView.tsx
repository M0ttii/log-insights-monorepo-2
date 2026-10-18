"use client"
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  ArrowRight,
  CircleAlert,
  Clock3,
  Database,
  Search,
  SlidersHorizontal,
} from "lucide-react"
import type { ToolOutcome } from "@workspace/domain/tool"
import { searchLogsOutputSchema } from "@workspace/domain/tools/search-logs"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  NativeSelect,
  NativeSelectOption,
} from "@workspace/ui/components/native-select"
import { Badge } from "@workspace/ui/components/badge"
import { Card, CardContent } from "@workspace/ui/components/card"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@workspace/ui/components/empty"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { ReceiptLink } from "@/components/evidence/ReceiptLink"
import { receiptFeatures } from "@/components/evidence/features"
import { ToolErrorNotice } from "@/components/workspace/ToolErrorNotice"
import { EventContext } from "./EventContext"
import { messageParts } from "./matches"

export function LogsView({
  initial,
  outcome,
}: {
  initial: Record<string, string>
  outcome: ToolOutcome<unknown> | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [match, setMatch] = useState(initial.match ?? "terms")
  const [selected, setSelected] = useState<number | null>(null)
  const parsed = outcome?.ok
    ? searchLogsOutputSchema.safeParse(outcome.result.data)
    : null
  const data = parsed?.success ? parsed.data : null
  return (
    <div className="workspace-page">
      <h1 className="page-heading">Explore the logs</h1>
      <p className="page-description">
        Find an event. Read what happened around it.
      </p>
      <form
        className="mt-7 space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          const params = new URLSearchParams()
          const form = new FormData(event.currentTarget)
          for (const [key, value] of form)
            if (typeof value === "string" && value.trim())
              params.set(key, value.trim())
          startTransition(() => router.push(`/logs?${params}`))
        }}
      >
        <div className="flex flex-wrap gap-2">
          <div className="min-w-48 flex-1">
            <Label htmlFor="log-query" className="sr-only">
              Search message text
            </Label>
            <Input
              id="log-query"
              name="q"
              defaultValue={initial.q}
              placeholder="Search message text…"
              required
              maxLength={200}
              className="h-9"
            />
          </div>
          <Button disabled={pending} type="submit" className="h-9">
            <Search />
            {pending ? "Searching…" : "Search"}
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label
              htmlFor="log-dataset"
              className="text-xs text-muted-foreground"
            >
              Dataset
            </Label>
            <NativeSelect
              id="log-dataset"
              name="dataset"
              defaultValue={initial.dataset ?? ""}
            >
              <NativeSelectOption value="">All datasets</NativeSelectOption>
              <NativeSelectOption value="bgl">BGL</NativeSelectOption>
              <NativeSelectOption value="openstack">
                OpenStack
              </NativeSelectOption>
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="match-mode"
              className="text-xs text-muted-foreground"
            >
              Match
            </Label>
            <NativeSelect
              id="match-mode"
              name="match"
              value={match}
              onChange={(event) => setMatch(event.target.value)}
            >
              <NativeSelectOption value="terms">Terms</NativeSelectOption>
              <NativeSelectOption value="phrase">Phrase</NativeSelectOption>
              <NativeSelectOption value="fuzzy">Fuzzy</NativeSelectOption>
            </NativeSelect>
          </div>
          {match === "fuzzy" && (
            <div className="space-y-1.5">
              <Label htmlFor="edits" className="text-xs text-muted-foreground">
                Max edits
              </Label>
              <NativeSelect
                id="edits"
                name="max_edits"
                defaultValue={initial.max_edits ?? "1"}
              >
                <NativeSelectOption value="1">1 edit</NativeSelectOption>
                <NativeSelectOption value="2">2 edits</NativeSelectOption>
              </NativeSelect>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="sort" className="text-xs text-muted-foreground">
              Sort
            </Label>
            <NativeSelect
              id="sort"
              name="sort"
              defaultValue={initial.sort ?? "relevance"}
            >
              <NativeSelectOption value="relevance">
                Relevance
              </NativeSelectOption>
              <NativeSelectOption value="time_desc">
                Newest first
              </NativeSelectOption>
              <NativeSelectOption value="time_asc">
                Oldest first
              </NativeSelectOption>
            </NativeSelect>
          </div>
          <Collapsible className="contents">
            <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
              <SlidersHorizontal />
              Filters
            </CollapsibleTrigger>
            <CollapsibleContent
              keepMounted
              className="order-last w-full rounded-lg border p-4"
            >
              <p className="mb-4 text-xs text-muted-foreground">
                Times are ISO 8601 UTC. Start included, end excluded.
              </p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ["from", "From (UTC)"],
                  ["to", "To (UTC)"],
                  ["components", "Components · comma separated"],
                  ["teams", "Teams · fictional ownership"],
                  ["levels", "Levels · comma separated"],
                  ["node", "Node"],
                  ["rack", "Rack"],
                  ["request_id", "Request ID"],
                  ["instance_id", "Instance ID"],
                ].map(([name, label]) => (
                  <div key={name} className="space-y-1">
                    <Label htmlFor={`filter-${name}`} className="text-xs">
                      {label}
                    </Label>
                    <Input
                      id={`filter-${name}`}
                      name={name}
                      defaultValue={name ? initial[name] : ""}
                      placeholder={
                        name === "from" || name === "to"
                          ? "2005-06-01T00:00:00Z"
                          : undefined
                      }
                      maxLength={200}
                    />
                  </div>
                ))}
                {[
                  ["only_errors", "Error events only"],
                  ["only_alerts", "Dataset alerts only"],
                ].map(([name, label]) => (
                  <div key={name} className="space-y-1">
                    <Label htmlFor={`filter-${name}`}>{label}</Label>
                    <NativeSelect
                      id={`filter-${name}`}
                      name={name}
                      defaultValue={name ? (initial[name] ?? "") : ""}
                    >
                      <NativeSelectOption value="">No</NativeSelectOption>
                      <NativeSelectOption value="true">Yes</NativeSelectOption>
                    </NativeSelect>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
          <span className="ml-auto flex items-center gap-1.5 pb-1 text-xs text-muted-foreground">
            <Clock3 className="size-3.5" />
            UTC · [start, end)
          </span>
        </div>
      </form>
      <section
        className="mt-8"
        aria-live="polite"
        aria-busy={pending}
        aria-label="Search results"
      >
        {outcome && !outcome.ok && <ToolErrorNotice error={outcome.error} />}
        {!outcome && (
          <Empty className="min-h-80 rounded-lg border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Search />
              </EmptyMedia>
              <EmptyTitle>A starting point for your investigation</EmptyTitle>
              <EmptyDescription>
                Search the original messages, then open an event to inspect its
                context. Try “parity” in BGL or “503” in OpenStack.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {data && outcome?.ok && (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
              <span>
                Showing{" "}
                {outcome.result.receipt.rows_returned.toLocaleString("en-US")}{" "}
                of {data.total_matches.toLocaleString("en-US")} matching log
                events
              </span>
              <ReceiptLink
                id={outcome.result.receipt.receipt_id}
                fact={
                  outcome.result.facts.find(
                    (fact) => fact.path === "/result/total_matches"
                  )?.id
                }
              />
              <span className="text-muted-foreground">
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
              {data.truncated && <Badge variant="outline">Truncated</Badge>}
            </div>
            {data.total_matches === 0 ? (
              <Empty className="min-h-60 border">
                <EmptyHeader>
                  <EmptyTitle>No matching log events</EmptyTitle>
                  <EmptyDescription>
                    Try fewer terms, a different match mode, or a wider time
                    window.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Card className="min-w-0 overflow-hidden py-0 shadow-none">
                <CardContent className="p-0">
                  <Table aria-label="Matching log events">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Event · UTC</TableHead>
                        <TableHead>Component</TableHead>
                        <TableHead>Level</TableHead>
                        <TableHead className="min-w-72">
                          Original message
                        </TableHead>
                        <TableHead>
                          <span className="sr-only">Open context</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.hits.map((hit, index) => (
                        <TableRow key={hit.event_id}>
                          <TableCell className="align-top">
                            <Button
                              variant="link"
                              size="sm"
                              className="h-auto p-0 font-mono text-xs"
                              onClick={() => setSelected(hit.event_id)}
                            >
                              {hit.ts.replace("T", " ").replace("Z", "")}
                            </Button>
                            <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                              <Database className="size-3" />
                              {hit.dataset}
                              <ReceiptLink
                                id={outcome.result.receipt.receipt_id}
                                fact={
                                  outcome.result.facts.find(
                                    (fact) =>
                                      fact.path === `/result/hits/${index}/ts`
                                  )?.id
                                }
                              />
                            </span>
                          </TableCell>
                          <TableCell className="align-top text-xs">
                            {hit.component ?? "Unknown"}
                            <span className="mt-1 block max-w-48 truncate font-mono text-muted-foreground">
                              {hit.node ?? hit.request_id ?? "Unknown identity"}
                            </span>
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge variant="outline" className="gap-1">
                              <CircleAlert className="size-3" />
                              {hit.level ?? "Unknown"}
                            </Badge>
                          </TableCell>
                          <TableCell className="max-w-xl align-top">
                            <p className="font-mono text-xs leading-5 [overflow-wrap:anywhere] break-words whitespace-pre-wrap">
                              {hit.message === null
                                ? "Unknown"
                                : messageParts(
                                    hit.message,
                                    hit.match_ranges
                                  ).map((part) =>
                                    part.matched ? (
                                      <mark
                                        key={part.start}
                                        className="bg-(--match-highlight) text-foreground underline underline-offset-2"
                                      >
                                        {part.text}
                                      </mark>
                                    ) : (
                                      part.text
                                    )
                                  )}
                              {hit.message_truncated && (
                                <span className="text-muted-foreground">
                                  {" "}
                                  (cut)
                                </span>
                              )}
                            </p>
                            {hit.alert_label && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                Dataset label: {hit.alert_label}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="align-top">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Open context for event ${hit.event_id}`}
                              onClick={() => setSelected(hit.event_id)}
                            >
                              <ArrowRight />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </section>
      <EventContext eventId={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
