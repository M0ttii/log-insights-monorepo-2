import { FILTER_FIELDS } from "@workspace/domain/filters"
import { describe, expect, it } from "vitest"

import { compileFilter, dimensionExpression } from "./filters.ts"
import { SqlParams } from "./sql.ts"

const ALL = FILTER_FIELDS

function compile(
  filter: Parameters<typeof compileFilter>[0],
  accepted: readonly (typeof ALL)[number][] = ALL,
  alias?: string
) {
  const params = new SqlParams()
  const result = compileFilter(filter, {
    accepted,
    params,
    ...(alias === undefined ? {} : { alias }),
  })
  if (!result.ok) throw new Error(result.error.message)
  return { ...result.filter, params: params.values }
}

const TEAM =
  "coalesce((SELECT o.team FROM ownership o WHERE o.dataset = log_events.dataset AND o.component = log_events.component), 'unowned')"

describe("compileFilter", () => {
  it("compiles an empty filter to TRUE on the table", () => {
    expect(compile({})).toEqual({
      where: "TRUE",
      relation: "log_events",
      params: [],
    })
  })

  it("binds the window as text compared as TIMESTAMPTZ, [from, to)", () => {
    expect(
      compile({
        dataset: "bgl",
        from: "2005-06-03T00:00:00Z",
        to: "2005-06-04T00:00:00+02:00",
      })
    ).toEqual({
      where:
        "log_events.dataset = $1 AND log_events.ts >= $2::TIMESTAMPTZ AND log_events.ts < $3::TIMESTAMPTZ",
      relation: "log_events",
      params: ["bgl", "2005-06-03T00:00:00Z", "2005-06-04T00:00:00+02:00"],
    })
  })

  it("compiles every field in declaration order", () => {
    expect(
      compile({
        text: "cache parity",
        pattern_id: "0123456789abcdef",
        levels: ["FATAL", "ERROR"],
        components: ["KERNEL"],
        teams: ["Compute Platform", "unowned"],
        node: "R02-M1-N0-C:J12-U11",
        rack: "R02",
        alert_label: "KERNDTLB",
        only_errors: true,
        only_alerts: true,
      })
    ).toEqual({
      where: [
        "log_events_idx.component IN ($1)",
        TEAM.replaceAll("log_events.", "log_events_idx.") + " IN ($2, $3)",
        "log_events_idx.level IN ($4, $5)",
        "log_events_idx.node = $6",
        "log_events_idx.rack = $7",
        "log_events_idx.alert_label = $8",
        "log_events_idx.is_error",
        "log_events_idx.is_alert",
        "log_events_idx.pattern_id = $9",
        "log_events_idx.message @@ plainto_tsquery($10)",
      ].join(" AND "),
      relation: "log_events_idx",
      params: [
        "KERNEL",
        "Compute Platform",
        "unowned",
        "FATAL",
        "ERROR",
        "R02-M1-N0-C:J12-U11",
        "R02",
        "KERNDTLB",
        "0123456789abcdef",
        "cache parity",
      ],
    })
  })

  it("compiles the OpenStack fields and leaves false flags out", () => {
    expect(
      compile(
        {
          request_id: "req-1",
          instance_id: "b9000564-fe1a-409b-b8cc-1e88b294cd1d",
          only_errors: false,
        },
        ALL,
        "e"
      )
    ).toEqual({
      where: "e.request_id = $1 AND e.instance_id = $2",
      relation: "log_events",
      params: ["req-1", "b9000564-fe1a-409b-b8cc-1e88b294cd1d"],
    })
  })

  it("resolves teams through ownership with unowned as fallback", () => {
    expect(compile({ teams: ["unowned"] })).toEqual({
      where: `${TEAM} IN ($1)`,
      relation: "log_events",
      params: ["unowned"],
    })
  })

  it("keeps injection attempts as bound values", () => {
    const attack = "x' OR 1=1; DROP TABLE log_events; --"
    const compiled = compile({
      components: [attack],
      node: attack,
      text: attack,
    })
    expect(compiled.where).not.toContain(attack)
    expect(compiled.where).not.toContain("DROP")
    expect(compiled.params).toEqual([attack, attack, attack])
  })

  it("continues the numbering of an existing parameter list", () => {
    const params = new SqlParams()
    params.add(20)
    const result = compileFilter(
      { dataset: "openstack" },
      { accepted: ["dataset"], params }
    )
    expect(result).toEqual({
      ok: true,
      filter: { where: "log_events.dataset = $2", relation: "log_events" },
    })
    expect(params.values).toEqual([20, "openstack"])
  })

  it("rejects fields the tool did not declare and names the accepted ones", () => {
    const result = compileFilter(
      { dataset: "bgl", text: "parity", node: "R02" },
      { accepted: ["dataset", "from", "to"], params: new SqlParams() }
    )
    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid_input",
        message: "Invalid input at node: Unsupported field. (+1 more)",
        hint: "Remove node, text; this tool does not support it. Accepted fields: dataset, from, to.",
        issues: [
          { path: "node", message: "Unsupported field." },
          { path: "text", message: "Unsupported field." },
        ],
      },
    })
  })

  it("rejects qualifiers that are not plain identifiers", () => {
    expect(() =>
      compileFilter(
        {},
        { accepted: ALL, params: new SqlParams(), alias: "e; DROP" }
      )
    ).toThrow(RangeError)
  })
})

describe("dimensionExpression", () => {
  it("maps dimensions to allowlisted columns", () => {
    expect(dimensionExpression("component", "e")).toBe("e.component")
    expect(dimensionExpression("pattern", "e")).toBe("e.pattern_id")
    expect(dimensionExpression("team", "log_events")).toBe(TEAM)
  })

  it("rejects unknown dimensions and qualifiers", () => {
    expect(() => dimensionExpression("message", "e")).toThrow(RangeError)
    expect(() => dimensionExpression("level; DROP TABLE x", "e")).toThrow(
      RangeError
    )
    expect(() => dimensionExpression("level", "e.x")).toThrow(RangeError)
  })
})
