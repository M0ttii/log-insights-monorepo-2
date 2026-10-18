"use client"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { FileText } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
export function ReceiptLink({
  id,
  fact,
  children,
}: {
  id: string
  fact?: string
  children?: React.ReactNode
}) {
  const pathname = usePathname()
  const params = new URLSearchParams(useSearchParams().toString())
  params.set("receipt", id)
  if (fact) params.set("fact", fact)
  else params.delete("fact")
  return (
    <Button
      variant="outline"
      size="xs"
      className="max-w-full font-mono text-xs"
      render={<Link href={`${pathname}?${params}`} scroll={false} />}
      aria-label={`${typeof children === "string" || typeof children === "number" ? `${children}, ` : ""}${fact ? `Fact ${fact}, unchecked, open evidence` : `Open receipt ${id}`}`}
    >
      <FileText aria-hidden="true" />
      {children ?? fact ?? id}
    </Button>
  )
}
