import type { ToolContext } from "@workspace/domain/tool"
import {
  COUNT_FILTER,
  entityDistributionSchema,
  type CountEventsInput,
} from "@workspace/domain/tools/count-events"
import { z } from "zod"

import { compileFilter } from "./filters.ts"
import { exactCount, SqlParams } from "./sql.ts"
import type { Relation } from "./relations.ts"

// SQL regexes are selected from code; original matches retain their spelling.
const ENTITY_REGEX = {
  // Extract complete candidates first: a valid suffix of a C++ name or an
  // invalid address must never become a frequency fact. INET validates below.
  ip: "[A-Za-z0-9_:.%+-]+",
  path: "/[A-Za-z0-9._~!$&()*+,;=:@%+-]+(?:/[A-Za-z0-9._~!$&()*+,;=:@%+-]+)*/?",
  request_id: "req-[A-Za-z0-9-]+",
  object_id:
    "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|blk_-?[0-9]+|instance-[A-Za-z0-9_-]+",
} as const

// INET also accepts network masks and abbreviated IPv4 addresses. Restrict the
// entity to a host address, then let the native parser check groups and ranges.
const IP_HOST_SHAPE =
  "(?:[0-9]{1,3}[.]){3}[0-9]{1,3}|[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*"

const entityRow = z.object({
  rank: exactCount,
  entity: z.string().nullable(),
  events: exactCount,
  share: z.number().nullable(),
  total_events: exactCount.nullable(),
  matched_events: exactCount.nullable(),
  occurrences: exactCount.nullable(),
  distinct_entities: exactCount.nullable(),
  other_entities: exactCount.nullable(),
  other_events: exactCount.nullable(),
  other_share: z.number().nullable(),
})

/** Complete event/entity pairs, with repeated mentions in an event deduplicated in SQL. */
export async function entityDistribution(
  ctx: ToolContext,
  input: CountEventsInput,
  resolved?: { relation: Relation; filter: CountEventsInput; params: SqlParams }
) {
  const entity = input.entity
  if (entity === undefined)
    throw new Error("entity distribution without selection")
  const params = new SqlParams()
  for (const value of resolved?.params.values ?? []) params.add(value)
  const compiled = compileFilter(resolved?.filter ?? input, {
    accepted: COUNT_FILTER.fields,
    params,
    ...(resolved === undefined ? {} : { relation: resolved.relation }),
  })
  if (!compiled.ok) throw new Error("validated entity filter rejected")
  const { rel, where } = compiled.filter
  const native = {
    request_id: ["request_id"],
    object_id: ["instance_id", "block_id"],
    ip: ["client_ip"],
    path: [],
  } as const
  const columns = native[entity.type]
  const nativeColumns = columns
    .map((col) => `${rel.col(col)} AS ${col}`)
    .join(", ")
  const regex = `${params.add(ENTITY_REGEX[entity.type])}::VARCHAR`
  const matches = `unnest(regexp_extract_all(message, ${regex}, 0))`
  // A single sentence-ending period is punctuation, rather than part of the
  // original address. Native structured values are validated without trimming.
  const rawEntity =
    entity.type === "ip" ? `regexp_replace(${matches}, '[.]$', '')` : matches
  const valid =
    entity.type === "ip"
      ? `regexp_full_match(entity, ${params.add(IP_HOST_SHAPE)}::VARCHAR) AND try_cast(entity AS INET) IS NOT NULL`
      : "TRUE"
  const selected =
    entity.value === undefined
      ? "TRUE"
      : `entity = ${params.add(entity.value)}::VARCHAR`
  const limit = `${params.add(input.top_n)}::BIGINT`
  const sql = `WITH base AS (SELECT ${rel.col("event_id")} AS event_id, ${rel.col("message")} AS message${nativeColumns === "" ? "" : `, ${nativeColumns}`} FROM ${rel.from} WHERE ${where}), extracted AS (SELECT event_id, ${rawEntity} AS entity FROM base${columns.map((col) => ` UNION ALL SELECT event_id, ${col} AS entity FROM base WHERE ${col} IS NOT NULL`).join("")}), pairs AS (SELECT DISTINCT event_id, entity FROM extracted WHERE ${valid} AND ${selected}), grouped AS (SELECT entity, count(*) AS events FROM pairs GROUP BY entity), ranked AS (SELECT entity, events, row_number() OVER (ORDER BY events DESC, entity ASC) AS rank FROM grouped), summary AS (SELECT (SELECT count(*) FROM base) AS total_events, (SELECT count(DISTINCT event_id) FROM pairs) AS matched_events, coalesce(sum(events),0) AS occurrences, count(*) AS distinct_entities, count(*) FILTER (WHERE rank > ${limit}) AS other_entities, coalesce(sum(events) FILTER (WHERE rank > ${limit}),0) AS other_events FROM ranked) SELECT 0::BIGINT AS rank, NULL::VARCHAR AS entity, 0::BIGINT AS events, NULL::DOUBLE AS share, total_events, matched_events, occurrences, distinct_entities, other_entities, other_events, other_events::DOUBLE / nullif(total_events,0) AS other_share FROM summary UNION ALL SELECT rank, entity, events, events::DOUBLE / nullif((SELECT total_events FROM summary),0), NULL,NULL,NULL,NULL,NULL,NULL,NULL FROM ranked WHERE rank <= ${limit} ORDER BY rank`
  const result = await ctx.db.query(sql, params.values, ctx.signal)
  const [summary, ...groups] = result.rows.map((row) => entityRow.parse(row))
  if (summary === undefined)
    throw new Error("entity distribution without summary")
  return entityDistributionSchema.parse({
    type: entity.type,
    ...(entity.value === undefined ? {} : { value: entity.value }),
    total_events: summary.total_events,
    matched_events: summary.matched_events,
    occurrences: summary.occurrences,
    distinct_entities: summary.distinct_entities,
    groups: groups.map(({ entity: value, events, share }) => ({
      entity: value,
      events,
      share,
    })),
    other:
      summary.other_entities === 0
        ? null
        : {
            entities: summary.other_entities,
            events: summary.other_events,
            share: summary.other_share,
          },
    truncated: summary.other_entities !== 0,
  })
}
