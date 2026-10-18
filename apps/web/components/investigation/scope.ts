import {
  filterSchema,
  validateFilter,
  type Dataset,
  type Filter,
} from "@workspace/domain/filters"
import { formatInstant, parseInstant } from "@workspace/domain/time"

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

function utc(value: string | undefined, fallback: string) {
  const instant = value === undefined ? null : parseInstant(value)
  return instant === null
    ? fallback
    : formatInstant(instant).replace(/\.0+Z$/, "Z")
}

/** A readable request snapshot; values stay exactly those the user submitted. */
export function scopeSummary(scope: Filter): string {
  if (Object.keys(scope).length === 0) return "Scope: chosen by the agent"
  const filters = [
    scope.dataset === "bgl"
      ? "BGL"
      : scope.dataset === "openstack"
        ? "OpenStack"
        : "Dataset chosen by the agent",
    scope.from || scope.to
      ? `[${utc(scope.from, "span start")}, ${utc(scope.to, "span end")}) UTC`
      : "Full span",
    scope.components && `Components: ${scope.components.join(", ")}`,
    scope.teams && `Teams: ${scope.teams.join(", ")} (fictional ownership)`,
    scope.levels && `Levels: ${scope.levels.join(", ")}`,
    scope.node && `Node: ${scope.node}`,
    scope.rack && `Rack: ${scope.rack}`,
    scope.alert_label && `Dataset alert label: ${scope.alert_label}`,
    scope.only_errors && "Errors only",
    scope.only_alerts && "Dataset alerts only",
    scope.request_id && `Request: ${scope.request_id}`,
    scope.instance_id && `Instance: ${scope.instance_id}`,
    scope.endpoints && `Endpoints: ${scope.endpoints.join(", ")}`,
    scope.http_status &&
      `HTTP status: ${scope.http_status.min}–${scope.http_status.max}`,
    scope.pattern_id && `Pattern: ${scope.pattern_id}`,
    scope.text && `Message contains: ${scope.text}`,
  ]
  return `Scope: ${filters.filter(Boolean).join(" · ")}`
}
