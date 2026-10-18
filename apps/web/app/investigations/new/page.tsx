import { InvestigationView } from "@/components/investigation/InvestigationView"
import { loadBrief } from "@/server/brief"
import { chatAvailability } from "@/server/chat"

export const dynamic = "force-dynamic"

export default function Page() {
  return <InvestigationView brief={loadBrief()} {...chatAvailability()} />
}
