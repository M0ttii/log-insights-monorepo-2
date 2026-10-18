import { countEventsInputSchema } from "@workspace/domain/tools/count-events"
import { describe, expect, it } from "vitest"

import { dictionaryFacetRelation } from "./dictionary-facets.ts"

describe("measured full-span dictionary facets", () => {
  it("selects only the measured plain one-dimension scopes", () => {
    const relation = dictionaryFacetRelation(
      countEventsInputSchema.parse({
        group_by: ["level"],
      })
    )
    expect(relation?.from).toBe("log_events_idx")
    expect(relation?.countRows).toBe("count(*)")
  })

  it.each([
    { dataset: "bgl", group_by: ["node"] },
    { dataset: "openstack", group_by: ["component"] },
    { dataset: "hdfs", group_by: ["level"] },
    { group_by: ["team"] },
    { group_by: ["component", "level"] },
    { group_by: ["level"], text: "error" },
    { group_by: ["node"], only_errors: true },
    { group_by: ["level"], from: "2005-06-03T00:00:00Z" },
    { group_by: ["level"], compare: "previous_period" },
    { group_by: ["level"], entity: { type: "ip" } },
  ])("retains the existing path for an unproven scope: %j", (input) => {
    expect(
      dictionaryFacetRelation(countEventsInputSchema.parse(input))
    ).toBeUndefined()
  })
})
