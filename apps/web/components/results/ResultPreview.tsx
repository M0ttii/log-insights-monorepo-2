import { formatFactValue } from "@workspace/domain/facts"
import type { ToolResult } from "@workspace/domain/tool"
import { countEventsOutputSchema } from "@workspace/domain/tools/count-events"
import { recurringPatternsOutputSchema } from "@workspace/domain/tools/recurring-patterns"
import { latencyStatsOutputSchema } from "@workspace/domain/tools/latency-stats"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { ReceiptLink } from "@/components/evidence/ReceiptLink"

export function ResultPreview({ result }: { result: ToolResult<unknown> }) {
  const count = countEventsOutputSchema.safeParse(result.data)
  const patterns = recurringPatternsOutputSchema.safeParse(result.data)
  const latency = latencyStatsOutputSchema.safeParse(result.data)
  let rows: Record<string, unknown>[] = []
  let columns: string[] = []
  let path = ""
  if (count.success) {
    rows = count.data.groups
    columns = ["dataset", "team", "events", "share"]
    path = "/result/groups"
  } else if (patterns.success) {
    rows = patterns.data.patterns
    columns = ["pattern", "episodes", "events", "status"]
    path = "/result/patterns"
  } else if (latency.success) {
    rows = [latency.data.total]
    columns = [
      "api_access_events",
      "p50_ms",
      "p95_ms",
      "errors_4xx",
      "errors_5xx",
    ]
    path = "/result"
  } else return null
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">No results in this scope.</p>
    )
  return (
    <div className="min-w-0">
      <Table aria-label="Computed result preview">
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column} className="text-xs capitalize">
                {column === "events"
                  ? "Log events"
                  : column === "share"
                    ? "Share (0–1)"
                    : column.replaceAll("_", " ")}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={index}>
              {columns.map((column) => {
                const factPath = latency.success
                  ? `${path}/total/${column}`
                  : `${path}/${index}/${column}`
                const fact = result.facts.find((item) => item.path === factPath)
                const value = row[column]
                return (
                  <TableCell
                    key={column}
                    className="max-w-64 align-top text-xs whitespace-normal"
                  >
                    <span
                      className={
                        column === "pattern"
                          ? "line-clamp-3 font-mono leading-5"
                          : ""
                      }
                    >
                      {fact ? (
                        <ReceiptLink
                          id={result.receipt.receipt_id}
                          fact={fact.id}
                        >
                          {formatFactValue(fact.value)}
                        </ReceiptLink>
                      ) : value === null || value === undefined ? (
                        "Unknown"
                      ) : (
                        String(value)
                      )}
                    </span>
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="mt-2 text-xs text-muted-foreground">
        Preview of the returned result. Open details for the complete fields,
        scope and caveats.
      </p>
    </div>
  )
}
