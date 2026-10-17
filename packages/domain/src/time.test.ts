import { describe, expect, it } from "vitest"

import {
  bucketStarts,
  coverage,
  fillBuckets,
  formatInstant,
  parseInstant,
  previousPeriod,
} from "./time.ts"

// First BGL line: Unix seconds 1117838570, text time 2005-06-03-15.42.50.363779 (UTC−7).
const BGL_FIRST = "2005-06-03T22:42:50.363779Z"
const BGL_FIRST_MICROS = 1_117_838_570_363_779n
// Last BGL line according to the compatibility gate (technical.md § 5.2, point 2).
const BGL_LAST = "2006-01-04T16:00:05.233639Z"
const BGL_SPAN = { first: BGL_FIRST, last: BGL_LAST }

describe("parseInstant", () => {
  it("reads Z and offsets as the same instant", () => {
    expect(parseInstant("1970-01-01T00:00:00Z")).toBe(0n)
    expect(parseInstant("1970-01-01T01:00:00+01:00")).toBe(0n)
    expect(parseInstant("1969-12-31T19:00:00-05:00")).toBe(0n)
  })

  it("keeps microseconds", () => {
    expect(parseInstant(BGL_FIRST)).toBe(BGL_FIRST_MICROS)
    expect(parseInstant("2005-06-03T15:42:50.363779-07:00")).toBe(
      BGL_FIRST_MICROS
    )
    expect(parseInstant("1970-01-01T00:00:00.5Z")).toBe(500_000n)
  })

  it("rejects missing zones, finer than microseconds and impossible dates", () => {
    expect(parseInstant("2005-06-03T22:42:50")).toBeNull()
    expect(parseInstant("2005-06-03T22:42:50+0200")).toBeNull()
    expect(parseInstant("2005-06-03T22:42:50.1234567Z")).toBeNull()
    expect(parseInstant("2005-02-29T00:00:00Z")).toBeNull()
    expect(parseInstant("2004-02-29T00:00:00Z")).toBe(1_078_012_800_000_000n)
    expect(parseInstant("2005-06-03")).toBeNull()
  })
})

describe("formatInstant", () => {
  it("writes microseconds and Z like the tools' SQL", () => {
    expect(formatInstant(0n)).toBe("1970-01-01T00:00:00.000000Z")
    expect(formatInstant(BGL_FIRST_MICROS)).toBe(BGL_FIRST)
    expect(formatInstant(-1n)).toBe("1969-12-31T23:59:59.999999Z")
  })
})

describe("previousPeriod", () => {
  it("is equally long and ends where the window starts", () => {
    expect(
      previousPeriod({
        from: "2005-06-03T00:00:00Z",
        to: "2005-06-04T00:00:00Z",
      })
    ).toEqual({
      from: "2005-06-02T00:00:00.000000Z",
      to: "2005-06-03T00:00:00.000000Z",
    })
  })

  it("works across offsets", () => {
    // 00:00Z to 01:00Z is one hour; the hour before is 23:00Z to 00:00Z.
    expect(
      previousPeriod({
        from: "2005-06-03T02:00:00+02:00",
        to: "2005-06-03T01:00:00Z",
      })
    ).toEqual({
      from: "2005-06-02T23:00:00.000000Z",
      to: "2005-06-03T00:00:00.000000Z",
    })
  })

  it("rejects empty windows", () => {
    expect(() =>
      previousPeriod({
        from: "2005-06-03T00:00:00Z",
        to: "2005-06-03T00:00:00Z",
      })
    ).toThrow(RangeError)
  })
})

describe("coverage", () => {
  it("is full inside the span, including the last event's microsecond", () => {
    expect(
      coverage(
        { from: "2005-07-01T00:00:00Z", to: "2005-08-01T00:00:00Z" },
        BGL_SPAN
      )
    ).toBe("full")
    expect(
      coverage({ from: BGL_FIRST, to: "2006-01-04T16:00:05.233640Z" }, BGL_SPAN)
    ).toBe("full")
  })

  it("is partial when the window reaches past either end", () => {
    expect(
      coverage(
        { from: "2005-06-01T00:00:00Z", to: "2005-06-04T00:00:00Z" },
        BGL_SPAN
      )
    ).toBe("partial")
    expect(
      coverage({ from: BGL_LAST, to: "2006-01-04T16:00:05.233641Z" }, BGL_SPAN)
    ).toBe("partial")
  })

  it("is none without overlap; the end is exclusive", () => {
    expect(
      coverage(
        { from: "2004-01-01T00:00:00Z", to: "2005-01-01T00:00:00Z" },
        BGL_SPAN
      )
    ).toBe("none")
    expect(
      coverage({ from: "2005-06-03T00:00:00Z", to: BGL_FIRST }, BGL_SPAN)
    ).toBe("none")
    expect(
      coverage(
        { from: "2006-01-04T16:00:05.233640Z", to: "2006-02-01T00:00:00Z" },
        BGL_SPAN
      )
    ).toBe("none")
  })
})

describe("bucketStarts", () => {
  it("lists only buckets that overlap the window and the data span", () => {
    const span = { first: BGL_FIRST, last: "2005-06-05T01:00:00Z" }
    expect(
      bucketStarts(
        { from: "2005-06-01T00:00:00Z", to: "2005-06-08T00:00:00Z" },
        span,
        "day"
      )
    ).toEqual([
      "2005-06-03T00:00:00.000000Z",
      "2005-06-04T00:00:00.000000Z",
      "2005-06-05T00:00:00.000000Z",
    ])
    const endsAtMidnight = {
      first: BGL_FIRST,
      last: "2005-06-04T23:59:59.999999Z",
    }
    expect(
      bucketStarts(
        { from: "2005-06-01T00:00:00Z", to: "2005-06-08T00:00:00Z" },
        endsAtMidnight,
        "day"
      )
    ).toEqual(["2005-06-03T00:00:00.000000Z", "2005-06-04T00:00:00.000000Z"])
  })

  it("starts weeks on Monday", () => {
    // 2005-06-03 is a Friday; its week starts on Monday 2005-05-30.
    expect(
      bucketStarts(
        { from: "2005-06-03T00:00:00Z", to: "2005-06-10T00:00:00Z" },
        BGL_SPAN,
        "week"
      )
    ).toEqual(["2005-05-30T00:00:00.000000Z", "2005-06-06T00:00:00.000000Z"])
  })

  it("aligns hours and is empty outside the span", () => {
    expect(
      bucketStarts(
        { from: "2005-06-03T22:00:00Z", to: "2005-06-04T00:30:00Z" },
        BGL_SPAN,
        "hour"
      )
    ).toEqual([
      "2005-06-03T22:00:00.000000Z",
      "2005-06-03T23:00:00.000000Z",
      "2005-06-04T00:00:00.000000Z",
    ])
    expect(
      bucketStarts(
        { from: "2004-01-01T00:00:00Z", to: "2004-01-02T00:00:00Z" },
        BGL_SPAN,
        "hour"
      )
    ).toEqual([])
  })
})

function zero(bucket: string) {
  return { bucket, count: 0 }
}

describe("fillBuckets", () => {
  const starts = [
    "2005-06-03T00:00:00.000000Z",
    "2005-06-04T00:00:00.000000Z",
    "2005-06-05T00:00:00.000000Z",
  ]

  it("adds observed zeros inside the span and matches buckets by instant", () => {
    expect(
      fillBuckets([{ bucket: "2005-06-04T00:00:00Z", count: 5 }], starts, zero)
    ).toEqual([
      { bucket: "2005-06-03T00:00:00.000000Z", count: 0 },
      { bucket: "2005-06-04T00:00:00Z", count: 5 },
      { bucket: "2005-06-05T00:00:00.000000Z", count: 0 },
    ])
  })

  it("rejects rows outside the listed buckets", () => {
    expect(() =>
      fillBuckets([{ bucket: "2005-06-06T00:00:00Z", count: 1 }], starts, zero)
    ).toThrow(RangeError)
  })
})
