import { formatFactValue, type Fact } from "@workspace/domain/facts"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { ReceiptLink } from "@/components/evidence/ReceiptLink"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function label(value: string) {
  return value.replaceAll("_", " ")
}
function leaf(value: unknown) {
  if (value === null || value === undefined) return "Unknown"
  if (typeof value === "number") return formatFactValue(value)
  if (typeof value === "boolean") return value ? "Yes" : "No"
  return String(value)
}
/** Schema-shaped result tables for all registry tools, shared by every surface.
 * Values and order are preserved; only formatting and disclosure happen here.
 */
export function ResultView({
  value,
  facts,
  receiptId,
  path = "/result",
}: {
  value: unknown
  facts: Fact[]
  receiptId: string
  path?: string
}) {
  if (Array.isArray(value)) {
    if (value.length === 0)
      return (
        <p className="text-sm text-muted-foreground">
          No results in this scope.
        </p>
      )
    const first = value[0]
    if (isRecord(first)) {
      const keys = Object.keys(first).filter((key) => key !== "score")
      return (
        <Table aria-label={label(path.split("/").at(-1) ?? "Results")}>
          <TableHeader>
            <TableRow>
              {keys.map((key) => (
                <TableHead key={key} className="capitalize">
                  {label(key)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {value.map((row: unknown, index) => (
              <TableRow key={`${path}/${index}`}>
                {keys.map((key) => (
                  <TableCell
                    key={key}
                    className="max-w-md align-top whitespace-normal"
                  >
                    <ResultView
                      value={isRecord(row) ? row[key] : null}
                      facts={facts}
                      receiptId={receiptId}
                      path={`${path}/${index}/${key}`}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )
    }
    return (
      <ul className="space-y-2">
        {value.map((item: unknown, index) => (
          <li key={`${path}/${index}`}>
            <ResultView
              value={item}
              facts={facts}
              receiptId={receiptId}
              path={`${path}/${index}`}
            />
          </li>
        ))}
      </ul>
    )
  }
  if (isRecord(value))
    return (
      <dl className="space-y-4">
        {Object.entries(value)
          .filter(([key]) => key !== "answer_guidance" && key !== "score")
          .map(([key, child]) => (
            <div key={key} className="min-w-0">
              <dt className="mb-1 text-xs font-medium text-muted-foreground capitalize">
                {label(key)}
              </dt>
              <dd className="min-w-0 text-sm">
                <ResultView
                  value={child}
                  facts={facts}
                  receiptId={receiptId}
                  path={`${path}/${key}`}
                />
              </dd>
            </div>
          ))}
      </dl>
    )
  const fact = facts.find((item) => item.path === path)
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5 align-baseline">
      <span className="[overflow-wrap:anywhere] break-words">
        {leaf(value)}
      </span>
      {fact && <ReceiptLink id={receiptId} fact={fact.id} />}
    </span>
  )
}
