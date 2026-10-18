import "server-only"
import { NextResponse } from "next/server"
import type { ToolError } from "@workspace/domain/errors"

export function errorResponse(error: ToolError) {
  const status = {
    invalid_input: 400,
    not_found: 404,
    query_timeout: 504,
    db_unavailable: 503,
    receipt_unavailable: 503,
    limit_exceeded: 413,
    source_changed: 409,
  }[error.code]
  return NextResponse.json({ ok: false, error }, { status })
}
export function unavailable() {
  return errorResponse({
    code: "receipt_unavailable",
    message: "The receipt could not be read.",
    hint: "Check the receipt directory and try again.",
  })
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin")
  if (origin === null) return true
  try {
    const source = new URL(origin)
    // Next may use localhost internally while the browser uses 127.0.0.1.
    return (
      source.host === request.headers.get("host") &&
      source.protocol === new URL(request.url).protocol
    )
  } catch {
    return false
  }
}
export async function readInput(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) return {}
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 16384) {
      await reader.cancel()
      throw new Error("Input too large")
    }
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}
