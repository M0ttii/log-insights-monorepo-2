"use client"
import { useEffect, useState } from "react"
import { z } from "zod"
import { getLogContextOutputSchema } from "@workspace/domain/tools/get-log-context"
import { toolResultSchema } from "@workspace/domain/tool"
import { Button } from "@workspace/ui/components/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@workspace/ui/components/sheet"
import { ResultView } from "@/components/results/ResultView"
import { ReceiptLink } from "@/components/evidence/ReceiptLink"
const schema = toolResultSchema(getLogContextOutputSchema)
function ContextResult({ eventId }: { eventId: number }) {
  const [result, setResult] = useState<z.infer<typeof schema> | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/tools/get_log_context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "event", event_id: eventId }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body: unknown = await response.json()
        if (
          !response.ok ||
          typeof body !== "object" ||
          body === null ||
          !("result" in body)
        )
          throw new Error("Context unavailable")
        return setResult(schema.parse(body.result))
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Context unavailable. Check the dataset and try again.")
      })
    return () => controller.abort()
  }, [eventId])
  return (
    <div className="min-h-0 space-y-5 overflow-auto px-5 pb-5">
      {error ? (
        <p role="alert">{error}</p>
      ) : result ? (
        <>
          <ReceiptLink id={result.receipt.receipt_id} />
          <p className="text-xs text-muted-foreground">
            SereneDB {result.receipt.duration_ms} ms ·{" "}
            {result.receipt.truncated ? "Truncated" : "Complete"}
          </p>
          {result.notes.map((note) => (
            <p key={note} className="text-xs text-muted-foreground">
              {note}
            </p>
          ))}
          <ResultView
            value={result.data}
            facts={result.facts}
            receiptId={result.receipt.receipt_id}
          />
        </>
      ) : (
        <output>Loading event context…</output>
      )}
    </div>
  )
}
export function EventContext({
  eventId,
  onClose,
}: {
  eventId: number | null
  onClose: () => void
}) {
  return (
    <Sheet
      open={eventId !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent className="min-w-0 data-[side=right]:w-full data-[side=right]:sm:w-[48rem] data-[side=right]:sm:max-w-[85vw]">
        <SheetHeader className="border-b p-5">
          <SheetTitle>Event context</SheetTitle>
          <SheetDescription>
            Original events around event {eventId} · UTC
          </SheetDescription>
        </SheetHeader>
        {eventId !== null && <ContextResult key={eventId} eventId={eventId} />}
        <div className="px-5 pb-5">
          <Button variant="outline" size="sm" onClick={onClose}>
            Back to results
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
