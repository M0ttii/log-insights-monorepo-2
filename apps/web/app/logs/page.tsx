import { runTool } from "@/server/runtime"
import { LogsView } from "@/components/logs/LogsView"
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries(params))
    if (typeof value === "string" && !["receipt", "fact"].includes(key))
      query[key] = value
  const input: Record<string, unknown> = {
    query: query.q,
    match: query.match ?? "terms",
    sort: query.sort ?? "relevance",
    limit: 20,
  }
  for (const name of [
    "dataset",
    "from",
    "to",
    "node",
    "rack",
    "request_id",
    "instance_id",
  ])
    if (query[name]) input[name] = query[name]
  for (const name of ["components", "teams", "levels"])
    if (query[name])
      input[name] = query[name]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
  for (const name of ["only_errors", "only_alerts"])
    if (query[name] === "true") input[name] = true
  if (query.match === "fuzzy") input.max_edits = Number(query.max_edits ?? 1)
  const outcome = query.q ? await runTool("search_logs", input) : null
  return (
    <LogsView key={JSON.stringify(query)} initial={query} outcome={outcome} />
  )
}
