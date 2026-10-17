import type { ToolError } from "@workspace/domain/errors"
import type { Dataset, Filter, FilterField } from "@workspace/domain/filters"
import type { Scope } from "@workspace/domain/receipt"
import type { DataSpan } from "@workspace/domain/time"
import type { QueryRunner } from "@workspace/domain/tool"

import { corpusNotLoaded, getDataSpan, spanEnd } from "./corpus.ts"

/** Scope of a tool run (technical.md § 6.2): one window per dataset plus the other filters. */

export const ALL_DATASETS: readonly Dataset[] = ["bgl", "openstack"]

export type ResolvedWindow = {
  window: Scope["windows"][number]
  /** Observed span of the dataset over the whole load. */
  span: DataSpan
}

/**
 * The window per dataset: the given bounds, else the data span (end
 * exclusive). Reads each span through the tool's runner, so the queries
 * appear in its receipt.
 */
export async function resolveWindows(
  db: QueryRunner,
  datasets: readonly Dataset[],
  bounds: Pick<Filter, "from" | "to">,
  signal: AbortSignal
): Promise<
  { ok: true; windows: ResolvedWindow[] } | { ok: false; error: ToolError }
> {
  const windows: ResolvedWindow[] = []
  for (const dataset of datasets) {
    const span = await getDataSpan(db, dataset, signal)
    if (span === null) return { ok: false, error: corpusNotLoaded }
    windows.push({
      window: {
        dataset,
        from: bounds.from ?? span.first,
        to: bounds.to ?? spanEnd(span),
      },
      span,
    })
  }
  return { ok: true, windows }
}

/** The filters besides dataset and window, as given. */
export function scopeFilters(
  input: Partial<Filter>,
  accepted: readonly FilterField[]
): Scope["filters"] {
  const filters: Partial<Filter> = {}
  for (const field of accepted) {
    if (field === "dataset" || field === "from" || field === "to") continue
    const value = input[field]
    if (value !== undefined) Object.assign(filters, { [field]: value })
  }
  return filters
}

/** `bgl [from, to), openstack [from, to)` for notes. */
export function describeWindows(windows: Scope["windows"]): string {
  return windows
    .map(({ dataset, from, to }) => `${dataset} [${from}, ${to})`)
    .join(", ")
}

/** `field=value, …` for notes; values as JSON so log-derived text stays quoted. */
export function describeFilters(filters: Scope["filters"]): string {
  return Object.entries(filters)
    .map(([field, value]) => `${field}=${JSON.stringify(value)}`)
    .join(", ")
}
