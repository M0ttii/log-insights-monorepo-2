import { NextResponse } from "next/server"
import { notFound } from "@workspace/domain/errors"
import { runtime } from "@/server/runtime"
import { errorResponse, unavailable } from "@/server/http"
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const receipt = await runtime().receipts.get(id)
    return receipt
      ? NextResponse.json(receipt)
      : errorResponse(notFound("receipt", id))
  } catch {
    return unavailable()
  }
}
