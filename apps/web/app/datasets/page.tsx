import { runTool } from "@/server/runtime"
import { loadBrief } from "@/server/brief"
import { CorpusView } from "@/components/datasets/CorpusView"
export default async function Page() {
  return (
    <CorpusView
      outcome={await runTool("describe_corpus", {})}
      playbookVersion={loadBrief().version}
    />
  )
}
