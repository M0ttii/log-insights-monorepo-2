"use client"
import { useEffect, useId, useState } from "react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { FileText } from "lucide-react"
import { formatFactValue, type Fact } from "@workspace/domain/facts"
import { receiptSchema, type Receipt } from "@workspace/domain/receipt"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

type Preview =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; scope: Receipt["scope"]; fact?: Fact }

function ReceiptPreview({ id, fact }: { id: string; fact?: string }) {
  const [preview, setPreview] = useState<Preview>({ kind: "loading" })
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const timeout = setTimeout(() => controller.abort(), 10_000)
    async function load() {
      try {
        const response = await fetch(
          `/api/receipts/${encodeURIComponent(id)}`,
          {
            signal: controller.signal,
          }
        )
        if (!response.ok) throw new Error("Receipt unavailable")
        const parsed = receiptSchema.safeParse(await response.json())
        if (!parsed.success || parsed.data.receipt_id !== id)
          throw new Error("Receipt unavailable")
        if (active)
          setPreview({
            kind: "ready",
            scope: parsed.data.scope,
            fact: parsed.data.facts.find((item) => item.id === fact),
          })
      } catch {
        if (active) setPreview({ kind: "unavailable" })
      } finally {
        clearTimeout(timeout)
      }
    }
    void load()
    return () => {
      active = false
      clearTimeout(timeout)
      controller.abort()
    }
  }, [id, fact])

  if (preview.kind === "loading") return <p>Loading receipt…</p>
  if (preview.kind === "unavailable") return <p>Receipt unavailable.</p>
  return (
    <>
      {preview.fact ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt>Value</dt>
          <dd>{formatFactValue(preview.fact.value)}</dd>
          <dt>Metric</dt>
          <dd>{preview.fact.metric}</dd>
          <dt>Unit</dt>
          <dd>{preview.fact.unit}</dd>
          <dt>Group</dt>
          <dd>
            {Object.entries(preview.fact.group)
              .map(([name, value]) => `${name}: ${value}`)
              .join(" · ") || "Ungrouped"}
          </dd>
        </dl>
      ) : (
        <p>
          {fact ? "Fact unavailable in this receipt." : "No fact selected."}
        </p>
      )}
      <div className="space-y-1 border-t border-current/20 pt-2">
        <p className="font-medium">Scope</p>
        {preview.scope.windows.length ? (
          preview.scope.windows.map((window) => (
            <p key={`${window.dataset}-${window.from}-${window.to}`}>
              {window.dataset}
              {window.period ? ` · ${window.period}` : ""} [{window.from},{" "}
              {window.to}) UTC
            </p>
          ))
        ) : (
          <p>No corpus time window.</p>
        )}
        <p>Filters: {JSON.stringify(preview.scope.filters)}</p>
      </div>
    </>
  )
}

export function ReceiptLink({
  id,
  fact,
  children,
  status = "unchecked",
  mismatchOn,
}: {
  id: string
  fact?: string
  children?: React.ReactNode
  status?: "verified" | "mismatch" | "unresolved" | "unchecked"
  mismatchOn?: readonly ("value" | "metric" | "group")[]
}) {
  const [open, setOpen] = useState(false)
  const previewId = useId()
  const pathname = usePathname()
  const params = new URLSearchParams(useSearchParams().toString())
  params.set("receipt", id)
  if (fact) params.set("fact", fact)
  else params.delete("fact")
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        render={<Link href={`${pathname}?${params}`} scroll={false} />}
        className={buttonVariants({
          variant: "outline",
          size: "xs",
          className: "max-w-full font-mono text-xs",
        })}
        aria-label={`${typeof children === "string" || typeof children === "number" ? `${children}, ` : ""}${fact ? `Fact ${fact}, ${status}, open evidence` : `Open receipt ${id}`}`}
        aria-describedby={open ? previewId : undefined}
      >
        <FileText aria-hidden="true" />
        {children ?? fact ?? id}
      </TooltipTrigger>
      <TooltipContent
        id={previewId}
        role="tooltip"
        className="block max-h-80 max-w-sm space-y-2 overflow-auto break-words"
      >
        <p className="font-mono">
          {fact ?? id} · {status}
        </p>
        {status === "mismatch" && mismatchOn?.length ? (
          <p>Mismatch on: {mismatchOn.join(", ")}</p>
        ) : null}
        {open && (
          <ReceiptPreview key={`${id}-${fact ?? ""}`} id={id} fact={fact} />
        )}
      </TooltipContent>
    </Tooltip>
  )
}
