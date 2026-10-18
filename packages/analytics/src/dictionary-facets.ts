import type { CountEventsInput } from "@workspace/domain/tools/count-events"

import { logEventsRelation, type Relation } from "./relations.ts"

/** G12/LOG-34: nullable implicit facets preserve NULL; explicit ts_dict_* do not.
 * Only measured full-span single keyword facets opt in. In particular, never
 * combine count(*) dictionary rewrites with FTS (the G13 OTel miscount), time
 * bounds, comparisons or other filters. OpenStack-only was slower in the probe.
 */
export function dictionaryFacetRelation(
  input: CountEventsInput
): Relation | undefined {
  const [dimension] = input.group_by
  if (
    input.group_by.length !== 1 ||
    !["level", "component", "node"].some((value) => value === dimension) ||
    input.dataset !== undefined ||
    Object.entries(input).some(
      ([key, value]) =>
        value !== undefined && !["group_by", "dataset", "top_n"].includes(key)
    )
  )
    return undefined
  return { ...logEventsRelation({ indexed: true }), countRows: "count(*)" }
}
