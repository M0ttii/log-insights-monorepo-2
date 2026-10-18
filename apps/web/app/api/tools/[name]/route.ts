import { NextResponse } from "next/server"
import { runTool } from "@/server/runtime"
import { errorResponse, readInput, sameOrigin } from "@/server/http"
const tools = new Set([
  "describe_corpus",
  "search_logs",
  "get_log_context",
  "count_events",
  "event_trend",
  "recurring_patterns",
  "latency_stats",
  "check_claims",
])
export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  if (!sameOrigin(request)) return new NextResponse(null, { status: 403 })
  const { name } = await params
  if (!tools.has(name)) return new NextResponse(null, { status: 404 })
  let input: unknown
  try {
    input = await readInput(request)
  } catch {
    return errorResponse({
      code: "invalid_input",
      message: "Invalid request body.",
      hint: "Send a JSON object smaller than 16 KB.",
      issues: [],
    })
  }
  const outcome = await runTool(name, input, request.signal)
  return outcome.ok ? NextResponse.json(outcome) : errorResponse(outcome.error)
}
