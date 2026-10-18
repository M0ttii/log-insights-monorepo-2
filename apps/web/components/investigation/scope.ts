import {
  filterSchema,
  validateFilter,
  type Dataset,
  type Filter,
} from "@workspace/domain/filters"

export function readScope(value: Record<string, unknown> = {}): Filter {
  // The dev question bank uses singular team/component labels. The tool filter
  // contract uses arrays; normalize that boundary without losing the example.
  const { team, component, ...rest } = value
  const parsed = filterSchema.safeParse({
    ...rest,
    ...(typeof team === "string" ? { teams: [team] } : {}),
    ...(typeof component === "string" ? { components: [component] } : {}),
  })
  return parsed.success ? parsed.data : {}
}

export function changeDataset(scope: Filter, dataset?: Dataset): Filter {
  if (scope.dataset === dataset) return scope
  return dataset ? { dataset } : {}
}

export function scopeError(scope: Filter): string | null {
  const parsed = filterSchema.safeParse(scope)
  if (!parsed.success)
    return parsed.error.issues[0]?.message ?? "Check the scope."
  const error = validateFilter(parsed.data)
  return error?.code === "invalid_input"
    ? (error.issues[0]?.message ?? error.message)
    : (error?.message ?? null)
}
