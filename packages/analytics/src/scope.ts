import { DATASETS, isExternal, type Dataset } from "@workspace/domain/datasets"
import type { ToolError } from "@workspace/domain/errors"
import type { Filter, FilterField } from "@workspace/domain/filters"
import type { Scope } from "@workspace/domain/receipt"
import type { DataSpan } from "@workspace/domain/time"
import type { QueryRunner } from "@workspace/domain/tool"

import {
  corpusNotLoaded,
  loadedDatasets,
  requireDataSpan,
  spanEnd,
} from "./corpus.ts"

/** Scope of a tool run (technical.md § 6.2): one window per dataset plus the other filters. */

/**
 * Every log_events dataset of the current load, in catalog order (U26).
 * External datasets (otel, LOG-35) are read only when named: a call without
 * a dataset never touches remote files.
 */
export const LOADED = "loaded"

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
  datasets: readonly Dataset[] | typeof LOADED,
  bounds: Pick<Filter, "from" | "to">,
  signal: AbortSignal
): Promise<
  | {
      ok: true
      windows: ResolvedWindow[]
      /** Loaded external datasets left out of a LOADED scope. */
      excluded: Dataset[]
    }
  | { ok: false; error: ToolError }
> {
  const loaded = datasets === LOADED ? await loadedDatasets(db, signal) : []
  const list =
    datasets === LOADED
      ? loaded.filter((dataset) => !isExternal(dataset))
      : datasets
  const excluded = loaded.filter(isExternal)
  if (list.length === 0) return { ok: false, error: corpusNotLoaded }
  const windows: ResolvedWindow[] = []
  for (const dataset of list) {
    const required = await requireDataSpan(db, dataset, signal)
    if (!required.ok) return required
    const { span } = required
    windows.push({
      window: {
        dataset,
        from: bounds.from ?? span.first,
        to: bounds.to ?? spanEnd(span),
      },
      span,
    })
  }
  return { ok: true, windows, excluded }
}

/** Note for a scope without dataset while an external dataset is loaded. */
export function excludedNote(excluded: readonly Dataset[]): string[] {
  return excluded.length === 0
    ? []
    : [
        `${excluded.join(", ")} is loaded but not included: remote datasets are read only when named (dataset ${excluded[0]}), so these totals cover the log_events datasets only.`,
      ]
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

/** `bgl [from, to), openstack [from, to), …` for notes. */
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

/**
 * R-02 (U26): with only_errors over several datasets, a dataset without an
 * error definition contributes no error events because they are unknown,
 * not because there are none. Named in the notes instead of a silent zero.
 */
export function unknownErrorsNote(
  input: Pick<Filter, "only_errors">,
  windows: readonly Scope["windows"][number][]
): string[] {
  if (input.only_errors !== true) return []
  const unknown = [
    ...new Set(
      windows
        .map(({ dataset }) => dataset)
        .filter((dataset) => DATASETS[dataset].errorDefinition === null)
    ),
  ]
  return unknown.length === 0
    ? []
    : [
        `only_errors: ${unknown.join(", ")} has no error definition (no level or error marker in the log, R-02); its error events are unknown, not zero, and are not counted.`,
      ]
}
