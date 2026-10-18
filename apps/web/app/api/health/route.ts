/** Process readiness only: probing a tool would write a receipt each time. */
export function GET() {
  return Response.json({ status: "ok" })
}
