import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  dbUnavailable,
  formatIssuePath,
  formatToolError,
  fromZodError,
  invalidInput,
  limitExceeded,
  notFound,
  queryTimeout,
  receiptUnavailable,
  toolErrorSchema,
  type ToolError,
} from "./errors.ts"

const every: ToolError[] = [
  invalidInput([{ path: "to", message: "Must be later than from." }]),
  notFound("event", "42"),
  queryTimeout(10_000),
  dbUnavailable(),
  receiptUnavailable(),
  limitExceeded("Buckets", 120, 365),
]

describe("ToolError", () => {
  it("covers every code once, each with a hint, valid against its schema", () => {
    expect(every.map((error) => error.code)).toEqual([
      "invalid_input",
      "not_found",
      "query_timeout",
      "db_unavailable",
      "receipt_unavailable",
      "limit_exceeded",
    ])
    for (const error of every) {
      expect(toolErrorSchema.parse(error)).toEqual(error)
      expect(error.hint.length).toBeGreaterThan(10)
      expect(formatToolError(error)).toBe(
        `${error.code}: ${error.message} Hint: ${error.hint}`
      )
    }
  })

  it("says how to narrow a timed-out query", () => {
    expect(queryTimeout(10_000).hint).toMatch(/Narrow the time range/)
  })

  it("names the first issue and how many more", () => {
    const error = invalidInput([
      { path: "from", message: "A" },
      { path: "to", message: "B" },
    ])
    expect(error.message).toBe("Invalid input at from: A (+1 more)")
  })
})

describe("fromZodError", () => {
  const schema = z.strictObject({
    limit: z.number().max(50),
    claims: z.array(z.strictObject({ fact: z.string() })),
  })

  it("maps paths with array indices", () => {
    const parsed = schema.safeParse({
      limit: 51,
      claims: [{ fact: "a" }, { fact: 3 }],
    })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const error = fromZodError(parsed.error)
    expect(error.code).toBe("invalid_input")
    if (error.code !== "invalid_input") return
    expect(error.issues.map((issue) => issue.path)).toEqual([
      "limit",
      "claims[1].fact",
    ])
  })

  it("rejects unknown fields and lists the accepted ones", () => {
    const parsed = schema.safeParse({ limit: 1, claims: [], node: "x" })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const error = fromZodError(parsed.error, ["limit", "claims"])
    expect(error.code).toBe("invalid_input")
    if (error.code !== "invalid_input") return
    expect(error.issues).toEqual([
      { path: "node", message: "Unsupported field." },
    ])
    expect(error.hint).toBe(
      "Remove node; this tool does not support it. Accepted fields: limit, claims."
    )
  })
})

describe("formatIssuePath", () => {
  it("joins keys with dots and indices in brackets", () => {
    expect(formatIssuePath([])).toBe("")
    expect(formatIssuePath(["claims", 2, "group", "team"])).toBe(
      "claims[2].group.team"
    )
  })
})
