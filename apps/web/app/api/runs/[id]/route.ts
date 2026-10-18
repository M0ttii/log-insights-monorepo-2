import { runIdSchema } from "@workspace/agent/ai-sdk"
import { publicRunMetadata } from "@/server/chat"
import { runtime as getRuntime } from "@/server/runtime"

export const runtime = "nodejs"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!runIdSchema.safeParse(id).success)
    return new Response(null, { status: 404 })
  try {
    const record = await getRuntime().runs.get(id)
    return record
      ? Response.json(publicRunMetadata(record), {
          headers: { "Cache-Control": "no-store" },
        })
      : new Response(null, { status: 404 })
  } catch {
    return Response.json(
      {
        ok: false,
        error: {
          code: "run_unavailable",
          message: "The run could not be read.",
          hint: "Check the local run directory and try again.",
        },
      },
      { status: 503 }
    )
  }
}
