import { runTool } from "@/server/runtime"
import { OverviewView } from "@/components/workspace/OverviewView"
export default async function Page() {
  const outcomes = await Promise.all([
    runTool("describe_corpus", {}),
    runTool("count_events", { group_by: ["dataset", "team"] }),
    runTool("count_events", {
      group_by: ["dataset", "team"],
      only_errors: true,
    }),
    runTool("event_trend", {
      dataset: "bgl",
      bucket: "week",
      only_errors: true,
    }),
    runTool("recurring_patterns", {
      dataset: "bgl",
      rank: "episodes",
      limit: 5,
    }),
    runTool("recurring_patterns", {
      dataset: "openstack",
      rank: "episodes",
      limit: 5,
    }),
    runTool("latency_stats", { group_by: "endpoint", top_n: 5 }),
  ])
  return <OverviewView outcomes={outcomes} />
}
