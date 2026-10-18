import { useState } from "react"
import { getToolName, isToolUIPart, type UIMessage } from "ai"
import { z } from "zod"
import { Download } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import {
  outcomeSchema,
  projectMessage,
  publicDataPart,
  type PublicRun,
} from "./mapper"
import type { RunContext } from "./types"

const metadataSchema = z.object({
  model_id: z.string(),
  guidance_version: z.string(),
  contract_version: z.string(),
  data_version: z.string().nullable(),
  started_at: z.string(),
})

/** Export an allowlist of public parts, never reasoning or provider metadata. */
export function publicParts(message: UIMessage) {
  const projected = projectMessage(message)
  const answerParts = new Set([...projected.draft, ...projected.final])
  return message.parts.flatMap((part): object[] => {
    if (part.type === "text" && answerParts.has(part))
      return [{ type: "text", text: part.text }]
    if (isToolUIPart(part)) {
      const parsed = outcomeSchema.safeParse(
        "output" in part ? part.output : null
      )
      return [
        {
          type: "dynamic-tool",
          toolName: getToolName(part),
          toolCallId: part.toolCallId,
          state: part.state,
          input: part.input,
          ...(parsed.success ? { output: parsed.data } : {}),
        },
      ]
    }
    const data = publicDataPart(part)
    if (data) return [data]
    return []
  })
}

export function ExportRun({
  message,
  context,
  run,
}: {
  message: UIMessage
  context: RunContext
  run: PublicRun
}) {
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={saving}
        onClick={async () => {
          setError(false)
          setSaving(true)
          try {
            const response = await fetch(
              `/api/runs/${encodeURIComponent(run.run_id)}`
            )
            const metadata = metadataSchema.safeParse(await response.json())
            if (!response.ok || !metadata.success)
              throw new Error("Run metadata unavailable")
            const exported = {
              format: "log-insights-run",
              version: 1,
              ...context,
              ...metadata.data,
              ...run,
              message: {
                id: message.id,
                role: "assistant",
                parts: publicParts(message),
              },
            }
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(exported, null, 2)], {
                type: "application/json",
              })
            )
            const anchor = document.createElement("a")
            anchor.href = url
            anchor.download = `${run.run_id}.json`
            anchor.click()
            URL.revokeObjectURL(url)
          } catch {
            setError(true)
          } finally {
            setSaving(false)
          }
        }}
      >
        <Download />
        {saving ? "Exporting…" : "Export run"}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-muted-foreground">
          Could not export this run. The run metadata may be unavailable; try
          again.
        </p>
      )}
    </>
  )
}
