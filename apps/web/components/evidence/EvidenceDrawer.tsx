"use client"
import { z } from "zod"
import { toolResultSchema } from "@workspace/domain/tool"
import { toolErrorSchema, type ToolError } from "@workspace/domain/errors"
import { ReceiptLink } from "./ReceiptLink"
import { useEffect, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { AlertCircle, Check, Database, RotateCcw } from "lucide-react"
import { receiptSchema, type Receipt } from "@workspace/domain/receipt"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@workspace/ui/components/tabs"
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockCopyButton,
} from "@workspace/ui/components/code-block"
import { ResultView } from "@/components/results/ResultView"
import { ToolErrorNotice } from "@/components/workspace/ToolErrorNotice"
import { receiptFeatures } from "./features"

function Code({ title, value }: { title: string; value: string }) {
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockCopyButton value={value} />
      </CodeBlockHeader>
      <CodeBlockContent className="max-h-96" aria-label={title}>
        {value}
      </CodeBlockContent>
    </CodeBlock>
  )
}
function ReceiptPanel({ id, fact }: { id: string; fact: string | null }) {
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [error, setError] = useState("")
  const [rerun, setRerun] = useState("")
  const [rerunError, setRerunError] = useState<ToolError | null>(null)
  const [running, setRunning] = useState(false)
  const [newReceipt, setNewReceipt] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/receipts/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const parsed = receiptSchema.safeParse(await response.json())
        if (!response.ok || !parsed.success)
          throw new Error("Receipt unavailable")
        return setReceipt(parsed.data)
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Receipt unavailable. Check the ID and the shared receipt directory."
          )
      })
    return () => controller.abort()
  }, [id])
  async function rerunReceipt() {
    setRunning(true)
    setRerun("")
    setRerunError(null)
    setNewReceipt(null)
    try {
      const response = await fetch(
        `/api/receipts/${encodeURIComponent(id)}/rerun`,
        { method: "POST" }
      )
      const body: unknown = await response.json()
      const failure = z
        .object({ ok: z.literal(false), error: toolErrorSchema })
        .safeParse(body)
      if (failure.success) {
        setRerunError(failure.data.error)
        return
      }
      const value = z
        .object({
          result: toolResultSchema(z.unknown()),
          matches: z.object({
            signature: z.boolean(),
            data_version: z.boolean(),
            result_digest: z.boolean(),
          }),
        })
        .safeParse(body)
      if (!response.ok || !value.success) throw new Error("Rerun failed")
      setNewReceipt(value.data.result.receipt.receipt_id)
      const matches = value.data.matches
      setRerun(
        !matches.data_version
          ? "Data version changed"
          : !matches.signature
            ? "Query signature changed"
            : !matches.result_digest
              ? "Result differs"
              : "Same result"
      )
    } catch {
      setRerun("Re-run failed. Check SereneDB and try again.")
    } finally {
      setRunning(false)
    }
  }
  if (error)
    return (
      <p role="alert" className="p-5 text-sm leading-6">
        <AlertCircle className="mb-3 size-5" />
        {error}
      </p>
    )
  if (!receipt)
    return (
      <output className="p-5 text-sm text-muted-foreground">
        Loading receipt…
      </output>
    )
  const selectedFact = receipt.facts.find((item) => item.id === fact)
  return (
    <section
      className="min-h-0 space-y-5 overflow-auto px-5 pb-6"
      aria-label="Receipt details"
    >
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">
          <Database />
          {receipt.tool}
        </Badge>
        <Badge variant="secondary">client {receipt.client}</Badge>
        <span className="data-label">SereneDB {receipt.duration_ms} ms</span>
      </div>
      {fact &&
        (selectedFact ? (
          <section className="rounded-lg border p-3">
            <h3 className="mb-2 font-mono text-xs">{selectedFact.id}</h3>
            <p className="text-sm">
              {selectedFact.value} · {selectedFact.metric} · {selectedFact.unit}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {JSON.stringify(selectedFact.group)} · unchecked in this view
            </p>
          </section>
        ) : (
          <p role="alert">
            Unresolved fact: {fact}. No matching fact in this receipt.
          </p>
        ))}
      <div className="flex flex-wrap gap-1.5">
        {receiptFeatures(receipt.sql).map((feature) => (
          <Badge
            key={feature.label}
            variant="secondary"
            title={feature.description}
          >
            {feature.label}
          </Badge>
        ))}
      </div>
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2 text-xs">
        <dt className="text-muted-foreground">Data version</dt>
        <dd className="font-mono break-all">{receipt.data_version}</dd>
        <dt className="text-muted-foreground">Signature</dt>
        <dd className="font-mono break-all">{receipt.signature}</dd>
        <dt className="text-muted-foreground">Result digest</dt>
        <dd className="font-mono break-all">{receipt.result_digest}</dd>
        <dt className="text-muted-foreground">Population</dt>
        <dd>
          {receipt.population
            ? `${receipt.population.count.toLocaleString("en-US")} ${receipt.population.unit.replaceAll("_", " ")}`
            : "Not applicable"}
        </dd>
        <dt className="text-muted-foreground">Returned</dt>
        <dd>
          {receipt.rows_returned} rows ·{" "}
          {receipt.truncated ? "truncated" : "complete"}
        </dd>
      </dl>
      <Tabs defaultValue="result">
        <TabsList className="w-full max-w-full overflow-x-auto">
          <TabsTrigger value="result">Result</TabsTrigger>
          <TabsTrigger value="sql">SQL</TabsTrigger>
          <TabsTrigger value="input">Input & scope</TabsTrigger>
          {receipt.source && <TabsTrigger value="source">Source</TabsTrigger>}
          <TabsTrigger value="facts">Facts</TabsTrigger>
        </TabsList>
        <TabsContent value="result" className="pt-4">
          <ResultView
            value={receipt.result}
            facts={receipt.facts}
            receiptId={id}
          />
        </TabsContent>
        <TabsContent value="sql" className="space-y-4 pt-4">
          {receipt.sql.map((sql, index) => (
            <Code
              key={sql}
              title={`SQL · statement ${index + 1}`}
              value={sql}
            />
          ))}
          <Code
            title="Bound parameters"
            value={JSON.stringify(receipt.params, null, 2)}
          />
        </TabsContent>
        <TabsContent value="input" className="space-y-4 pt-4">
          <Code
            title="Validated input"
            value={JSON.stringify(receipt.input, null, 2)}
          />
          <Code
            title="Scope · [start, end) UTC"
            value={JSON.stringify(receipt.scope, null, 2)}
          />
        </TabsContent>
        {receipt.source && (
          <TabsContent value="source" className="min-w-0 pt-4">
            <section aria-label="Receipt source" className="min-w-0 space-y-4">
              <p className="text-sm leading-6 text-muted-foreground">
                {receipt.source.kind === "otlp_replay"
                  ? "Bounded OTLP replay. This run reads the recorded replay and index snapshot, not a production stream."
                  : receipt.source.path === "indexed_window"
                    ? "Indexed reference window. Files, query bounds, version stamps, and index freshness are recorded below."
                    : "Direct scan of the recorded remote files and query bounds. Bytes read are not measured; any footer estimate is labelled separately."}
              </p>
              <ResultView
                value={receipt.source}
                facts={[]}
                receiptId={id}
                path="/source"
              />
            </section>
          </TabsContent>
        )}
        <TabsContent value="facts" className="pt-4">
          <ResultView value={receipt.facts} facts={[]} receiptId={id} />
        </TabsContent>
      </Tabs>
      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        <Button onClick={rerunReceipt} disabled={running} size="sm">
          <RotateCcw aria-hidden="true" />
          {running ? "Running…" : "Re-run"}
        </Button>
        <output className="flex items-center gap-1.5 text-xs">
          {rerun === "Same result" && <Check className="size-3.5" />}
          {rerun}
        </output>
        {newReceipt && <ReceiptLink id={newReceipt} />}
      </div>
      {rerunError && <ToolErrorNotice error={rerunError} />}
    </section>
  )
}
export function EvidenceDrawer() {
  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const id = params.get("receipt")
  return (
    <Sheet
      open={Boolean(id)}
      onOpenChange={(open) => {
        if (!open) {
          const next = new URLSearchParams(params.toString())
          next.delete("receipt")
          next.delete("fact")
          router.replace(`${pathname}?${next}`, { scroll: false })
        }
      }}
    >
      <SheetContent className="w-full min-w-0 gap-4 sm:w-[40rem] sm:max-w-[85vw]">
        <SheetHeader className="border-b p-5">
          <SheetTitle>Query receipt</SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {id}
          </SheetDescription>
        </SheetHeader>
        {id && <ReceiptPanel key={id} id={id} fact={params.get("fact")} />}
      </SheetContent>
    </Sheet>
  )
}
