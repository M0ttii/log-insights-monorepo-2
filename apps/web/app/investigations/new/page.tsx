import { InvestigationView } from "@/components/investigation/InvestigationView"
import { loadBrief } from "@/server/brief"
export default function Page() {
  return <InvestigationView brief={loadBrief()} />
}
