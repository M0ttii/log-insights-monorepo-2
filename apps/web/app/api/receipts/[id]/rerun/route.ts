import { NextResponse } from "next/server"
import { runtime } from "@/server/runtime"
import { errorResponse, unavailable, sameOrigin } from "@/server/http"
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!sameOrigin(request)) return new NextResponse(null, { status: 403 })
  const { id } = await params
  try {
    const outcome = await runtime().registry.rerun(id, {
      client: "web",
      signal: request.signal,
    })
    return outcome.ok
      ? NextResponse.json(outcome)
      : errorResponse(outcome.error)
  } catch {
    return unavailable()
  }
}
