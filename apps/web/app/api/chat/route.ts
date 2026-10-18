import { chatResponse } from "@/server/chat"

export const runtime = "nodejs"

export async function POST(request: Request) {
  return chatResponse(request)
}
