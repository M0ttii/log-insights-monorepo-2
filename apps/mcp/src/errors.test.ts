import {
  dbUnavailable,
  invalidInput,
  limitExceeded,
  notFound,
  queryTimeout,
  receiptUnavailable,
  sourceChanged,
} from "@workspace/domain/errors"
import { describe, expect, it } from "vitest"

import { toResourceError, toToolErrorResult } from "./errors.ts"

describe("MCP error mapping", () => {
  it.each([
    invalidInput([{ path: "limit", message: "Must be positive." }]),
    notFound("receipt", "r_00000000"),
    queryTimeout(10_000),
    dbUnavailable(),
    receiptUnavailable(),
    limitExceeded("Rows", 50, 51),
    sourceChanged("otel", ["part_000.parquet"]),
  ])("preserves the expected $code message and correction hint", (error) => {
    const result = toToolErrorResult(error)
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: JSON.stringify(error) }],
    })
    expect(toResourceError(error).data).toEqual(error)
  })

  it("has a generic unexpected-error message with a hint", () => {
    expect(JSON.stringify(toToolErrorResult())).toContain("hint")
    expect(toResourceError().data).toMatchObject({
      code: "internal_error",
      hint: expect.any(String),
    })
  })
})
