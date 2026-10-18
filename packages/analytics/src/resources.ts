import type { ToolOutcome } from "@workspace/domain/tool"

import type { CallContext, Registry } from "./registry.ts"
import { describeCorpus } from "./tools/describe-corpus.ts"

export type CorpusResourceName = "overview" | "schema" | "ownership"

/**
 * Resource reads share describe_corpus's validated computation and receipt.
 * Each read creates that ordinary tool receipt; the projection keeps its
 * original fact IDs and paths, which resolve against the complete receipt.
 * No resource invents another query, numerical source or fact namespace.
 */
export async function readCorpusResource(
  registry: Registry,
  name: CorpusResourceName,
  call: CallContext
): Promise<ToolOutcome<unknown>> {
  call.signal.throwIfAborted()
  const outcome = await registry.runTool("describe_corpus", {}, call)
  call.signal.throwIfAborted()
  if (!outcome.ok) return outcome

  const corpus = describeCorpus.output.parse(outcome.result.data)
  const { versions } = corpus
  let data: unknown
  switch (name) {
    case "overview":
      data = {
        datasets: corpus.datasets.map(
          ({ fields: _fields, ...dataset }) => dataset
        ),
        limits: corpus.limits,
        versions,
        answer_guidance: corpus.answer_guidance,
        guidance_version: corpus.guidance_version,
      }
      break
    case "schema":
      data = {
        datasets: corpus.datasets.map(({ dataset, fields, capabilities }) => ({
          dataset,
          fields,
          capabilities,
        })),
        versions,
      }
      break
    case "ownership":
      data = { ownership: corpus.ownership, versions }
      break
  }

  return { ok: true, result: { ...outcome.result, data } }
}
