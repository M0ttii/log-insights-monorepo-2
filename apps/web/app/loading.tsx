import { Skeleton } from "@workspace/ui/components/skeleton"
export default function Loading() {
  return (
    <output
      className="workspace-page block space-y-5"
      aria-label="Loading workspace"
    >
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-5 w-72 max-w-full" />
      <Skeleton className="mt-8 h-64 w-full" />
      <span className="sr-only">Loading workspace…</span>
    </output>
  )
}
