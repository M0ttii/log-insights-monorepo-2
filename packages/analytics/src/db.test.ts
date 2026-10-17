import { describe, expect, it } from "vitest"

import {
  createDatabase,
  QUERY_TIMEOUT_MS,
  QueryFailure,
  toToolError,
} from "./db.ts"

/** Nothing listens on port 1, so connecting fails at once without Docker. */
const unreachable = {
  host: "127.0.0.1",
  port: 1,
  user: "nobody",
  password: "unused",
  database: "none",
}

describe("toToolError", () => {
  it("maps a timeout (SQLSTATE 57014) to query_timeout with the limit", () => {
    expect(
      toToolError(new QueryFailure("timeout", "57014"), QUERY_TIMEOUT_MS)
    ).toEqual({
      code: "query_timeout",
      message: "The query did not finish within 10000 ms and was cancelled.",
      hint: "Narrow the time range, add a dataset or component filter, or use a coarser grouping.",
      timeout_ms: 10_000,
    })
  })

  it("maps connection loss to db_unavailable and a full pool to limit_exceeded", () => {
    expect(toToolError(new QueryFailure("unavailable"), 10_000)?.code).toBe(
      "db_unavailable"
    )
    expect(toToolError(new QueryFailure("busy"), 10_000)).toEqual({
      code: "limit_exceeded",
      message: "Concurrent tool queries exceeds the limit of 12.",
      hint: "Too many tool calls run at once; wait for the running calls to finish, then call again.",
      limit: 12,
      requested: null,
    })
  })

  it("maps cancellations and other failures to no tool error", () => {
    expect(toToolError(new QueryFailure("cancelled"), 10_000)).toBeNull()
    expect(toToolError(new QueryFailure("failed", "42601"), 10_000)).toBeNull()
  })

  it("keeps database text out of the failure message", () => {
    expect(new QueryFailure("failed", "42P01").message).toBe(
      "query failed (SQLSTATE 42P01)"
    )
  })
})

describe("createDatabase", () => {
  it("connects lazily and reports an unreachable server as unavailable", async () => {
    const lines: string[] = []
    const db = createDatabase(unreachable, { log: (line) => lines.push(line) })
    expect(lines).toEqual([])
    const failure = await db
      .query("SELECT 1", [], new AbortController().signal)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(QueryFailure)
    expect(failure).toMatchObject({ kind: "unavailable" })
    expect(lines).toEqual(["db connect failed code=ECONNREFUSED"])
    await db.dispose()
  })

  it("does not connect for an already cancelled call", async () => {
    const lines: string[] = []
    const db = createDatabase(unreachable, { log: (line) => lines.push(line) })
    const controller = new AbortController()
    controller.abort()
    await expect(
      db.query("SELECT 1", [], controller.signal)
    ).rejects.toMatchObject({
      kind: "cancelled",
    })
    expect(lines).toEqual([])
    await db.dispose()
  })
})
