import { FILTER_FIELDS } from "@workspace/domain/filters"
import { describe, expect, it } from "vitest"

import {
  apiAccessCondition,
  compileFilter,
  dimensionExpression,
} from "./filters.ts"
import { otelIndexRelation, otelScanRelation } from "./relations.ts"
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
  return {
    where: result.filter.where,
    relation: result.filter.relation,
    params: params.values,
  }
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

  it("reads the index relation on request, for tools with their own full-text condition", () => {
    const params = new SqlParams()
    const result = compileFilter(
      { dataset: "bgl" },
      { accepted: ALL, params, relation: "log_events_idx" }
    )
    expect(result.ok && result.filter).toMatchObject({
      where: "log_events_idx.dataset = $1",
      relation: "log_events_idx",
    })
    expect(() =>
      compileFilter(
        { text: "parity" },
        { accepted: ALL, params: new SqlParams(), relation: "log_events" }
      )
    ).toThrow("a text filter needs the full-text index relation")
  })

  it("compiles the OpenStack fields and leaves false flags out", () => {
    expect(
      compile(
        {
          request_id: "req-1",
          instance_id: "b9000564-fe1a-409b-b8cc-1e88b294cd1d",
          endpoints: ["/v2/<ID>/servers/detail", "/latest/meta-data/"],
          http_status: { min: 500, max: 599 },
          only_errors: false,
        },
        ALL,
        "e"
      )
    ).toEqual({
      where:
        "e.request_id = $1 AND e.instance_id = $2 AND e.endpoint IN ($3, $4) AND e.http_status BETWEEN $5 AND $6",
      relation: "log_events",
      params: [
        "req-1",
        "b9000564-fe1a-409b-b8cc-1e88b294cd1d",
        "/v2/<ID>/servers/detail",
        "/latest/meta-data/",
        500,
        599,
      ],
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
    expect(result).toMatchObject({
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

describe("compileFilter on the otel relations (LOG-35)", () => {
  const ranges = [
    {
      file_index: 0,
      from: "2025-09-23T00:00:00.000000000Z",
      to: "2025-09-23T00:29:24.039037200Z",
    },
    { file_index: 1, from: "2025-09-23T00:29:24.039037200Z", to: null },
  ]

  it("binds the window as TIMESTAMPTZ_NS on the reference index and maps is_error to the catalog levels", () => {
    const params = new SqlParams()
    const result = compileFilter(
      {
        dataset: "otel",
        from: "2025-09-23T00:29:20Z",
        to: "2025-09-23T00:29:30Z",
        components: ["cart"],
        only_errors: true,
        text: "cache full",
      },
      {
        accepted: ALL,
        params,
        relation: otelIndexRelation("otel_ref_idx", ranges),
      }
    )
    if (!result.ok) throw new Error(result.error.message)
    // The dataset condition is dropped: the relation holds otel only.
    expect(result.filter.where).toBe(
      "otel_ref_idx.ts >= $1::TIMESTAMPTZ_NS AND otel_ref_idx.ts < $2::TIMESTAMPTZ_NS AND otel_ref_idx.component IN ($3) AND (otel_ref_idx.level IN ('error', 'fatal')) AND otel_ref_idx.message @@ plainto_tsquery($4)"
    )
    expect(params.values).toEqual([
      "2025-09-23T00:29:20Z",
      "2025-09-23T00:29:30Z",
      "cart",
      "cache full",
    ])
    expect(result.filter.rel.col("event_id")).toBe(
      "(CASE WHEN otel_ref_idx.ts >= '2025-09-23T00:29:24.039037200Z'::TIMESTAMPTZ_NS THEN 1010000000000 ELSE 1000000000000 END::BIGINT + otel_ref_idx.file_row_number)"
    )
    expect(result.filter.rel.col("node")).toBe("NULL::VARCHAR")
    expect(result.filter.rel.col("pattern_id")).toBe("NULL::VARCHAR")
  })

  it("reads each scan file with its own half-open bounds as plain sargable comparisons", () => {
    const params = new SqlParams()
    const rel = otelScanRelation(
      [
        {
          file_index: 0,
          url: "https://public-pme.s3.eu-west-3.amazonaws.com/text_bench/part_000.parquet",
          read_from: "2025-09-23T00:29:00.000000000Z",
          read_to: "2025-09-23T00:29:24.039037200Z",
        },
        {
          file_index: 1,
          url: "https://public-pme.s3.eu-west-3.amazonaws.com/text_bench/part_001.parquet",
          read_from: "2025-09-23T00:29:24.039037200Z",
          read_to: "2025-09-23T00:29:50.000000000Z",
        },
      ],
      params
    )
    expect(rel.from).toContain(
      `FROM read_parquet('https://public-pme.s3.eu-west-3.amazonaws.com/text_bench/part_000.parquet', file_row_number = true) WHERE "Timestamp" >= $1::TIMESTAMPTZ_NS AND "Timestamp" < $2::TIMESTAMPTZ_NS UNION ALL SELECT 1010000000000::BIGINT + file_row_number AS event_id`
    )
    expect(params.values).toEqual([
      "2025-09-23T00:29:00.000000000Z",
      "2025-09-23T00:29:24.039037200Z",
      "2025-09-23T00:29:24.039037200Z",
      "2025-09-23T00:29:50.000000000Z",
    ])
    const result = compileFilter(
      { dataset: "otel", levels: ["error"] },
      { accepted: ALL, params, relation: rel }
    )
    expect(result.ok && result.filter.where).toBe("otel_scan.level IN ($5)")
    expect(rel.bucket("second")).toBe(
      "date_trunc('second', make_timestamptz(epoch_ns(otel_scan.ts) // 1000))"
    )
  })

  it("refuses a Parquet location outside the allowlist and a text filter on a scan", () => {
    expect(() =>
      otelScanRelation(
        [
          {
            file_index: 0,
            url: "https://example.invalid/x.parquet",
            read_from: "2025-09-23T00:00:00.000000000Z",
            read_to: "2025-09-23T00:00:01.000000000Z",
          },
        ],
        new SqlParams()
      )
    ).toThrow(RangeError)
    const rel = otelScanRelation(
      [
        {
          file_index: 0,
          url: "/data/raw/otel/part_000.parquet",
          read_from: "2025-09-23T00:00:00.000000000Z",
          read_to: "2025-09-23T00:00:01.000000000Z",
        },
      ],
      new SqlParams()
    )
    expect(() =>
      compileFilter(
        { dataset: "otel", text: "x" },
        { accepted: ALL, params: new SqlParams(), relation: rel }
      )
    ).toThrow("a text filter needs the full-text index relation")
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

describe("apiAccessCondition", () => {
  it("repeats the api_access view condition on the given relation", () => {
    expect(apiAccessCondition("log_events_idx")).toBe(
      "log_events_idx.dataset = 'openstack' AND log_events_idx.http_status IS NOT NULL"
    )
    expect(() => apiAccessCondition("e; DROP")).toThrow(RangeError)
  })
})
