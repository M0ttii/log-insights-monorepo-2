import { AlertCircle } from "lucide-react"
import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@workspace/ui/components/alert"
import type { ToolError } from "@workspace/domain/errors"
export function ToolErrorNotice({ error }: { error: ToolError }) {
  return (
    <Alert>
      <AlertCircle />
      <AlertTitle>{error.message}</AlertTitle>
      <AlertDescription>{error.hint}</AlertDescription>
    </Alert>
  )
}
