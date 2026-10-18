"use client"
import { Button } from "@workspace/ui/components/button"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@workspace/ui/components/empty"
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <Empty className="min-h-96">
      <EmptyHeader>
        <EmptyTitle>This view could not be loaded</EmptyTitle>
        <EmptyDescription>
          Check the local configuration and SereneDB connection, then try again.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={reset}>Try again</Button>
      </EmptyContent>
    </Empty>
  )
}
