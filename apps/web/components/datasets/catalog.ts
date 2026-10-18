import { DATASETS, type Dataset } from "@workspace/domain/datasets"
import { datasetSchema } from "@workspace/domain/filters"
import type { ToolOutcome } from "@workspace/domain/tool"

/** Only IDs returned by describe_corpus may appear as loaded choices. */
export function loadedDatasetIds(outcome: ToolOutcome<unknown>): Dataset[] {
  if (!outcome.ok) return []
  const data = outcome.result.data
  if (
    typeof data !== "object" ||
    data === null ||
    !("datasets" in data) ||
    !Array.isArray(data.datasets)
  )
    return []
  return data.datasets.flatMap((row: unknown) => {
    if (typeof row !== "object" || row === null || !("dataset" in row))
      return []
    const parsed = datasetSchema.safeParse(row.dataset)
    return parsed.success ? [parsed.data] : []
  })
}

export function datasetTitle(dataset: Dataset): string {
  return DATASETS[dataset].title
}
