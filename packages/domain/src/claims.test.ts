import { describe, expect, it } from "vitest"

import {
  compareClaim,
  compareClaimValue,
  countClaims,
  parseClaimNumber,
  verificationLine,
} from "./claims.ts"
import { checkClaimsInputSchema } from "./tools/check-claims.ts"

const count = (value: number, unit = "log_events") => ({ value, unit })

describe("parseClaimNumber", () => {
  it("reads comma as thousands separator and dot as decimal point", () => {
    expect(parseClaimNumber("4,747,963")).toEqual({
      negative: false,
      digits: 4_747_963n,
      scale: 0,
    })
    expect(parseClaimNumber("1.204")).toEqual({
      negative: false,
      digits: 1204n,
      scale: 3,
    })
    expect(parseClaimNumber("1,204.50")).toEqual({
      negative: false,
      digits: 120_450n,
      scale: 2,
    })
    expect(parseClaimNumber("-12")).toEqual({
      negative: true,
      digits: 12n,
      scale: 0,
    })
    expect(parseClaimNumber("+12")).toEqual({
      negative: false,
      digits: 12n,
      scale: 0,
    })
  })

  it("rejects ambiguous or decorated forms", () => {
    for (const text of [
      "1,20",
      "1,2045",
      ",204",
      "1.204,5",
      "37.5%",
      "1 204",
      "1e3",
      "120 events",
      "",
      "0x10",
    ])
      expect.soft(parseClaimNumber(text)).toBeNull()
  })

  it("reads JSON numbers from their shortest decimal form, including exponents", () => {
    expect(parseClaimNumber(0.38)).toEqual({
      negative: false,
      digits: 38n,
      scale: 2,
    })
    expect(parseClaimNumber(2.1e-7)).toEqual({
      negative: false,
      digits: 21n,
      scale: 8,
    })
    expect(parseClaimNumber(1e21)).toEqual({
      negative: false,
      digits: 10n ** 21n,
      scale: 0,
    })
    expect(parseClaimNumber(-0)).toEqual({
      negative: false,
      digits: 0n,
      scale: 0,
    })
  })
})

describe("compareClaimValue: numbers", () => {
  it("matches integers exactly, with or without separators", () => {
    expect(compareClaimValue({ value: "4,747,963" }, count(4_747_963))).toBe(
      null
    )
    expect(compareClaimValue({ value: "4747963" }, count(4_747_963))).toBe(null)
    expect(compareClaimValue({ value: 4_747_963 }, count(4_747_963))).toBe(null)
    expect(compareClaimValue({ value: "1,204.0" }, count(1204))).toBe(null)
    expect(compareClaimValue({ value: "4,747,962" }, count(4_747_963))).toBe(
      "4,747,962 differs from the fact 4,747,963 rounded to 0 decimal places (4,747,963)"
    )
    expect(
      compareClaimValue({ value: "4,750,000" }, count(4_747_963))
    ).not.toBeNull()
  })

  it("never reads 1.204 as 1204", () => {
    expect(compareClaimValue({ value: "1.204" }, count(1204))).toMatch(
      /^1\.204 differs from the fact 1,204/
    )
    expect(compareClaimValue({ value: "1.204" }, count(1.204, "ratio"))).toBe(
      null
    )
  })

  it("rounds the fact to the stated decimal places, half away from zero", () => {
    const share = { value: 0.375, unit: "ratio" }
    expect(compareClaimValue({ value: "0.38" }, share)).toBe(null)
    expect(compareClaimValue({ value: 0.38 }, share)).toBe(null)
    expect(compareClaimValue({ value: "0.375" }, share)).toBe(null)
    expect(compareClaimValue({ value: "0.3750" }, share)).toBe(null)
    expect(compareClaimValue({ value: "0.4" }, share)).toBe(null)
    expect(compareClaimValue({ value: "0.37" }, share)).toBe(
      "0.37 differs from the fact 0.375 rounded to 2 decimal places (0.38)"
    )
    expect(compareClaimValue({ value: "0.3751" }, share)).not.toBeNull()
    // Negative deltas round away from zero as well.
    expect(compareClaimValue({ value: "-2.5" }, count(-2.45, "percent"))).toBe(
      null
    )
    expect(
      compareClaimValue({ value: "-2.4" }, count(-2.45, "percent"))
    ).not.toBeNull()
  })

  it("rounds the decimal form the model saw, not the binary value", () => {
    // 0.145 is stored as 0.1449999…; the JSON result shows 0.145.
    expect(compareClaimValue({ value: "0.15" }, count(0.145, "ratio"))).toBe(
      null
    )
    expect(
      compareClaimValue({ value: "0.0000002" }, count(2.106e-7, "ratio"))
    ).toBe(null)
  })

  it("compares a ratio as a fraction, or as percent with unit percent", () => {
    const share = { value: 0.375, unit: "ratio" }
    expect(compareClaimValue({ value: "37.5", unit: "percent" }, share)).toBe(
      null
    )
    expect(compareClaimValue({ value: 37.5, unit: "percent" }, share)).toBe(
      null
    )
    expect(compareClaimValue({ value: "38", unit: "percent" }, share)).toBe(
      null
    )
    expect(compareClaimValue({ value: "37", unit: "percent" }, share)).toBe(
      "37 % differs from the fact 37.5 % rounded to 0 decimal places (38 %)"
    )
    // Without the unit, 37.5 is not 0.375.
    expect(compareClaimValue({ value: "37.5" }, share)).not.toBeNull()
    expect(
      compareClaimValue({ value: "0.375", unit: "percent" }, share)
    ).not.toBeNull()
  })

  it("takes percent facts as they are and refuses percent on counts", () => {
    const change = { value: 100, unit: "percent" }
    expect(compareClaimValue({ value: "100", unit: "percent" }, change)).toBe(
      null
    )
    expect(compareClaimValue({ value: "100" }, change)).toBe(null)
    expect(compareClaimValue({ value: "91", unit: "percent" }, count(91))).toBe(
      'unit "percent" applies to ratio and percent facts only; this fact is in log_events'
    )
  })

  it("explains an unparseable value", () => {
    expect(compareClaimValue({ value: "37.5%" }, count(37.5, "ratio"))).toMatch(
      /^"37\.5%" is not a number in the answer format; .* pass unit "percent"/
    )
    expect(compareClaimValue({ value: "2005-06-03" }, count(2000))).toMatch(
      /is not a number/
    )
  })
})

describe("compareClaimValue: times", () => {
  const fact = { value: "2005-06-03T22:42:50.675872Z", unit: "utc_time" }

  it("matches an ISO prefix at day, minute, second and microsecond precision", () => {
    for (const value of [
      "2005-06",
      "2005-06-03",
      "2005-06-03T22",
      "2005-06-03T22:42",
      "2005-06-03T22:42Z",
      "2005-06-03 22:42",
      "2005-06-03T22:42:50",
      "2005-06-03T22:42:50Z",
      "2005-06-03T22:42:50.6",
      "2005-06-03T22:42:50.675872",
      "2005-06-03T22:42:50.675872Z",
    ])
      expect.soft(compareClaimValue({ value }, fact)).toBeNull()
  })

  it("truncates instead of rounding and rejects other days or offsets", () => {
    expect(compareClaimValue({ value: "2005-06-03T22:43" }, fact)).toBe(
      "2005-06-03T22:43 is not a prefix of the fact's time 2005-06-03T22:42:50.675872Z"
    )
    expect(compareClaimValue({ value: "2005-06-04" }, fact)).not.toBeNull()
    expect(
      compareClaimValue({ value: "2005-06-03T22:42:50.675873" }, fact)
    ).not.toBeNull()
    expect(compareClaimValue({ value: "2005-06-03T22:4" }, fact)).toMatch(
      /is not an ISO-8601 UTC time prefix/
    )
    expect(
      compareClaimValue({ value: "2005-06-04T00:42:50+02:00" }, fact)
    ).toMatch(/is not an ISO-8601 UTC time prefix/)
    expect(compareClaimValue({ value: 2005 }, fact)).toMatch(
      /^a time fact takes an ISO-8601 UTC string/
    )
    expect(
      compareClaimValue({ value: "2005-06-03", unit: "percent" }, fact)
    ).toBe('unit "percent" does not apply to a time fact')
  })

  it("compares against the canonical form of facts without microseconds", () => {
    const window = { value: "2005-06-03T00:00:00Z", unit: "utc_time" }
    expect(
      compareClaimValue({ value: "2005-06-03T00:00:00.000000Z" }, window)
    ).toBeNull()
  })
})

describe("compareClaim", () => {
  const requests = {
    value: 120,
    metric: "requests",
    unit: "requests",
    group: { dataset: "openstack" },
  }

  it("verifies value, metric and group together", () => {
    expect(
      compareClaim(
        { value: "120", metric: "requests", group: { dataset: "openstack" } },
        requests
      )
    ).toEqual({ status: "verified" })
  })

  it("reports requests: 120 stated as 120 errors as a metric mismatch (S-08)", () => {
    expect(
      compareClaim(
        { value: 120, metric: "errors", group: { dataset: "openstack" } },
        requests
      )
    ).toEqual({
      status: "mismatch",
      mismatch_on: ["metric"],
      reason: 'metric: "errors" differs from the fact\'s metric "requests"',
    })
  })

  it("requires the group to match keys and values exactly", () => {
    const fact = {
      value: 1204,
      metric: "events",
      unit: "log_events",
      group: { dataset: "bgl", team: "Compute Platform" },
    }
    const claim = (group: Record<string, string | number | boolean>) =>
      compareClaim({ value: "1,204", metric: "events", group }, fact)
    expect(claim({ team: "Compute Platform", dataset: "bgl" }).status).toBe(
      "verified"
    )
    expect(claim({ dataset: "bgl" })).toEqual({
      status: "mismatch",
      mismatch_on: ["group"],
      reason:
        'group: {"dataset":"bgl"} differs from the fact\'s group {"dataset":"bgl","team":"Compute Platform"}',
    })
    expect(claim({}).status).toBe("mismatch")
    expect(
      claim({ dataset: "bgl", team: "Compute Platform", level: "FATAL" }).status
    ).toBe("mismatch")
    expect(claim({ dataset: "bgl", team: "compute platform" }).status).toBe(
      "mismatch"
    )
  })

  it("accepts {} for an ungrouped fact and rejects a group on it", () => {
    const total = { value: 7, metric: "events", unit: "log_events", group: {} }
    expect(
      compareClaim({ value: 7, metric: "events", group: {} }, total)
    ).toEqual({ status: "verified" })
    expect(
      compareClaim(
        { value: 7, metric: "events", group: { dataset: "bgl" } },
        total
      ).status
    ).toBe("mismatch")
  })

  it("compares numeric group values in their string form", () => {
    const fact = {
      value: 3969,
      metric: "api_accesses",
      unit: "api_accesses",
      group: { http_status: "404" },
    }
    expect(
      compareClaim(
        { value: "3,969", metric: "api_accesses", group: { http_status: 404 } },
        fact
      ).status
    ).toBe("verified")
  })

  it("lists every differing field in the order value, metric, group", () => {
    const result = compareClaim(
      { value: 121, metric: "errors", group: { dataset: "bgl" } },
      requests
    )
    expect(result.status === "mismatch" ? result.mismatch_on : null).toEqual([
      "value",
      "metric",
      "group",
    ])
  })
})

describe("counts and verification line", () => {
  it("counts both unknown statuses as unresolved", () => {
    const counts = countClaims([
      "verified",
      "mismatch",
      "unknown_fact",
      "unknown_receipt",
      "verified",
    ])
    expect(counts).toEqual({
      checked: 5,
      verified: 2,
      mismatch: 1,
      unresolved: 2,
    })
    expect(verificationLine(counts)).toBe(
      "5 claims checked · 1 mismatch · 2 unresolved"
    )
    expect(verificationLine(countClaims(["verified"]))).toBe(
      "1 claim checked · 0 mismatch · 0 unresolved"
    )
  })
})

describe("checkClaimsInputSchema", () => {
  const claim = { fact: "r_7f3a9c21.f4", value: 1, metric: "events" }

  it("requires the group and says to pass {} for ungrouped facts", () => {
    const parsed = checkClaimsInputSchema.safeParse({ claims: [claim] })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ["claims", 0, "group"],
        message:
          "Required: the group the text attributes the number to; pass {} for ungrouped facts.",
      }),
    ])
    expect(
      checkClaimsInputSchema.safeParse({ claims: [{ ...claim, group: {} }] })
        .success
    ).toBe(true)
  })

  it("accepts malformed fact IDs so they become per-claim results", () => {
    expect(
      checkClaimsInputSchema.safeParse({
        claims: [{ ...claim, fact: "../../etc/passwd", group: {} }],
      }).success
    ).toBe(true)
  })

  it("limits claims to 1–30 and rejects unknown fields", () => {
    const one = { ...claim, group: {} }
    expect(checkClaimsInputSchema.safeParse({ claims: [] }).success).toBe(false)
    expect(
      checkClaimsInputSchema.safeParse({
        claims: Array.from({ length: 30 }, () => ({ ...one })),
      }).success
    ).toBe(true)
    expect(
      checkClaimsInputSchema.safeParse({
        claims: Array.from({ length: 31 }, () => ({ ...one })),
      }).success
    ).toBe(false)
    expect(
      checkClaimsInputSchema.safeParse({
        claims: [{ ...one, unit: "ratio" }],
      }).success
    ).toBe(false)
    expect(
      checkClaimsInputSchema.safeParse({ claims: [{ ...one, scope: {} }] })
        .success
    ).toBe(false)
  })
})
