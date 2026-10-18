import { performance } from "node:perf_hooks"

import {
  dbUnavailable,
  limitExceeded,
  queryTimeout,
  type ToolError,
} from "@workspace/domain/errors"
import type { QueryRunner } from "@workspace/domain/tool"
import { Client, DatabaseError, Pool, types, type PoolClient } from "pg"

import { loadConfig, type Connection } from "./config.ts"

/**
 * The only place that talks to SereneDB (technical.md § 4, § 12). One lazily
 * created pool per process with at most four connections, the session
 * contract of gate G1 and a 10 s limit the pool enforces itself, because
 * SereneDB accepts `statement_timeout` but does not enforce it (gate G6).
 */

/** Includes acquisition and setup; running queries are cancelled on the server. */
export const QUERY_TIMEOUT_MS = 10_000

/** Concurrent queries per process (§ 12); also the call limit MCP asks servers to enforce. */
const MAX_CONNECTIONS = 4

/**
 * Calls that may wait for a free connection. Two full rounds of the pool: a
 * web role comparison runs three chats at once, each with a tool call or two.
 * Beyond that a call fails fast with `limit_exceeded` instead of queueing.
 */
const MAX_WAITING_QUERIES = 8

/** Physical connection/late-checkout cleanup stays bounded after caller cancellation. */
const ACQUIRE_TIMEOUT_MS = 15_000

/**
 * After a cancel the query normally fails with 57014 within milliseconds. If
 * it does not (SereneDB unreachable for the cancel), the connection is ended
 * so the call cannot outlive the limit by more than this.
 */
const CANCEL_GRACE_MS = 2_000

/** TIMESTAMP and TIMESTAMPTZ cross the driver as raw text (§ 6.1); BIGINT and NUMERIC stay strings by default. */
const RAW_TEXT_OIDS = new Set([1114, 1184])

/** PostgreSQL `unknown`: what SereneDB sends for a result it could not type. */
const UNKNOWN_OID = 705

const rawTimestampTypes = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (RAW_TEXT_OIDS.has(oid)) return (value: string) => value
    return format === "binary"
      ? types.getTypeParser(oid, "binary")
      : types.getTypeParser(oid, "text")
  },
} as const

export type QueryFailureKind =
  "timeout" | "cancelled" | "unavailable" | "busy" | "failed"

/**
 * A failed query. The message carries the kind and SQLSTATE only, never
 * database text, so it is safe to log.
 */
export class QueryFailure extends Error {
  constructor(
    readonly kind: QueryFailureKind,
    readonly sqlstate: string | null = null
  ) {
    super(`query ${kind}${sqlstate === null ? "" : ` (SQLSTATE ${sqlstate})`}`)
    this.name = "QueryFailure"
  }
}

/**
 * The one mapping from database failures to tool errors (§ 8.4). `null` for
 * cancelled calls, which return nothing, and for other failures, which the
 * registry reports as a generic error without database text.
 */
export function toToolError(
  failure: QueryFailure,
  timeoutMs: number
): ToolError | null {
  switch (failure.kind) {
    case "timeout":
      return queryTimeout(timeoutMs)
    case "unavailable":
      return dbUnavailable()
    case "busy":
      return {
        ...limitExceeded(
          "Concurrent tool queries",
          MAX_CONNECTIONS + MAX_WAITING_QUERIES,
          null
        ),
        hint: "Too many tool calls run at once; wait for the running calls to finish, then call again.",
      }
    case "cancelled":
    case "failed":
      return null
  }
}

export type Database = QueryRunner & {
  readonly timeoutMs: number
  /** Ends the pool; the next query creates a new one. */
  dispose(): Promise<void>
}

export type DatabaseOptions = {
  timeoutMs?: number
  /** Operational log line without SQL, parameters or database text. */
  log?: (line: string) => void
}

/** Lazily connects on the first query, never at import or build time. */
export function createDatabase(
  connection: Connection,
  options: DatabaseOptions = {}
): Database {
  const timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS
  const log = options.log ?? logToStderr
  const backendPids = new WeakMap<PoolClient, number>()
  let pool: Pool | null = null

  const getPool = (): Pool => {
    if (pool !== null) return pool
    pool = new Pool({
      ...connection,
      max: MAX_CONNECTIONS,
      connectionTimeoutMillis: ACQUIRE_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
      types: rawTimestampTypes,
    })
    pool.on("error", (error) => log(`db idle connection lost ${kindOf(error)}`))
    return pool
  }

  const acquire = async (
    signal: AbortSignal,
    deadline: number
  ): Promise<PoolClient> => {
    const current = getPool()
    if (current.waitingCount >= MAX_WAITING_QUERIES)
      throw new QueryFailure("busy")
    let client: PoolClient | null = null
    let discarded = false
    let stopped: "timeout" | "cancelled" | null = null
    const discard = () => {
      if (client === null || discarded) return
      discarded = true
      // pg-pool removes the checkout and pg ends an active setup query by
      // destroying its socket, rather than waiting for that query to finish.
      client.release(true)
    }
    let onAbort: (() => void) | undefined
    let timer: NodeJS.Timeout | undefined
    const stop = new Promise<never>((_resolve, reject) => {
      const fail = (reason: "timeout" | "cancelled") => {
        if (stopped !== null) return
        stopped = reason
        discard()
        reject(new QueryFailure(reason))
      }
      onAbort = () => fail("cancelled")
      signal.addEventListener("abort", onAbort, { once: true })
      timer = setTimeout(
        () => fail("timeout"),
        Math.max(0, Math.ceil(deadline - performance.now()))
      )
      if (signal.aborted) onAbort()
    })
    const connecting = async () => {
      if (stopped !== null) throw new QueryFailure(stopped)
      try {
        client = await current.connect()
      } catch (error) {
        if (stopped !== null) throw new QueryFailure(stopped)
        // pg-pool also bounds a pending connection, including one whose
        // caller already stopped and whose eventual checkout must be discarded.
        log(`db connect failed ${kindOf(error)}`)
        throw new QueryFailure(
          current.totalCount >= MAX_CONNECTIONS ? "busy" : "unavailable"
        )
      }
      if (stopped !== null) {
        discard()
        throw new QueryFailure(stopped)
      }
      if (backendPids.has(client)) return client
      try {
        // A startup option `-c TimeZone=…` is ignored by SereneDB (gate G1).
        await client.query("SET TimeZone = 'UTC'")
        // HTTPFS connects can ignore pg_cancel_backend (LOG-35 probe § 8).
        // These engine options are GLOBAL and have no serened.conf flags.
        // Bound each request's connect/read/retry chain before external reads;
        // this is not a total query limit (the analytics pool still enforces 10 s).
        await client.query("SET GLOBAL http_timeout = 3")
        await client.query("SET GLOBAL http_retries = 1")
        if (stopped !== null) throw new QueryFailure(stopped)
        const { rows } = await client.query<{ pid: unknown }>(
          "SELECT pg_backend_pid() AS pid"
        )
        if (stopped !== null) throw new QueryFailure(stopped)
        backendPids.set(client, parsePid(rows[0]?.pid))
        return client
      } catch (error) {
        discard()
        if (stopped !== null) throw new QueryFailure(stopped)
        log(`db session setup failed ${kindOf(error)}`)
        throw new QueryFailure("unavailable")
      }
    }
    try {
      return await Promise.race([connecting(), stop])
    } finally {
      clearTimeout(timer)
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort)
    }
  }

  /** Cancels on the server through a connection outside the pool, so a full pool can still cancel. */
  const cancelBackend = async (pid: number): Promise<void> => {
    const client = new Client({
      ...connection,
      connectionTimeoutMillis: CANCEL_GRACE_MS,
    })
    try {
      await client.connect()
      await client.query("SELECT pg_cancel_backend($1)", [pid])
    } finally {
      await client.end().catch(() => undefined)
    }
  }

  const query: QueryRunner["query"] = async (sql, params, signal) => {
    if (signal.aborted) throw new QueryFailure("cancelled")
    const deadline = performance.now() + timeoutMs
    const client = await acquire(signal, deadline)
    let released = false
    const release = (destroy: boolean) => {
      if (released) return
      released = true
      client.release(destroy)
    }
    if (signal.aborted) {
      release(false)
      throw new QueryFailure("cancelled")
    }
    if (performance.now() >= deadline) {
      release(true)
      throw new QueryFailure("timeout")
    }
    const pid = backendPids.get(client)
    if (pid === undefined) {
      release(true)
      throw new QueryFailure("unavailable")
    }

    let stopped: "timeout" | "cancelled" | null = null
    let grace: NodeJS.Timeout | undefined
    const stop = (reason: "timeout" | "cancelled") => {
      if (stopped !== null) return
      stopped = reason
      cancelBackend(pid).catch((error: unknown) =>
        log(`db cancel failed ${kindOf(error)}`)
      )
      grace = setTimeout(() => release(true), CANCEL_GRACE_MS)
    }
    const timer = setTimeout(
      () => stop("timeout"),
      Math.max(0, Math.ceil(deadline - performance.now()))
    )
    const onAbort = () => stop("cancelled")
    signal.addEventListener("abort", onAbort, { once: true })

    const started = performance.now()
    let failed = false
    try {
      const result = await client.query<Record<string, unknown>>({
        text: sql,
        values: [...params],
      })
      // Finished in a race with the cancel: the result is dropped with the connection.
      if (stopped !== null) throw new QueryFailure(stopped)
      // SereneDB 26.10.1 describes a result whose types depend on a bound
      // parameter it cannot type (`$n + 1`, JSON functions over `$n`) as one
      // column `unknown` (OID 705), whatever the real columns are (gate G1).
      // Fail instead of returning rows under the wrong key; type the
      // parameter in the SQL (`$n::BIGINT`) to fix the query.
      if (result.fields.some((field) => field.dataTypeID === UNKNOWN_OID)) {
        log("db query result undescribed (oid 705)")
        throw new QueryFailure("failed")
      }
      return {
        rows: result.rows,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      }
    } catch (error) {
      failed = true
      if (error instanceof QueryFailure) throw error
      const sqlstate =
        error instanceof DatabaseError ? (error.code ?? null) : null
      if (stopped !== null) throw new QueryFailure(stopped, sqlstate)
      log(`db query failed ${kindOf(error)}`)
      // 57014 without our own cancel: cancelled by someone else; report it like a timeout.
      if (sqlstate === "57014") throw new QueryFailure("timeout", sqlstate)
      throw new QueryFailure(
        isConnectionError(error) ? "unavailable" : "failed",
        sqlstate
      )
    } finally {
      clearTimeout(timer)
      clearTimeout(grace)
      signal.removeEventListener("abort", onAbort)
      // After a timeout, a cancel or an error the connection is discarded (§ 12).
      release(failed || stopped !== null)
    }
  }

  return {
    timeoutMs,
    query,
    async dispose() {
      if (pool === null) return
      const current = pool
      pool = null
      await current.end()
    },
  }
}

/**
 * The process-wide database. The slot lives on `globalThis` under a
 * registered symbol so Next dev reloads, which re-evaluate this module,
 * reuse the pool instead of opening a second one.
 */
const DATABASE_KEY = Symbol.for("@workspace/analytics/database")

// Widening globalThis by one optional symbol slot; nothing else reads it.
const slots = globalThis as typeof globalThis & {
  [DATABASE_KEY]?: Database
}

export function getDatabase(
  connection: Connection = loadConfig().connection
): Database {
  slots[DATABASE_KEY] ??= createDatabase(connection)
  return slots[DATABASE_KEY]
}

/** For shutdown and test teardown. */
export async function disposeDatabase(): Promise<void> {
  const database = slots[DATABASE_KEY]
  if (database === undefined) return
  delete slots[DATABASE_KEY]
  await database.dispose()
}

function parsePid(value: unknown): number {
  const pid = typeof value === "string" ? Number(value) : value
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("pg_backend_pid() returned no process ID")
  return pid
}

/** Connection loss (class 08, admin shutdown 57P0x) or a socket error without SQLSTATE. */
function isConnectionError(error: unknown): boolean {
  if (error instanceof DatabaseError) {
    const code = error.code ?? ""
    return code.startsWith("08") || code.startsWith("57P0")
  }
  if (!(error instanceof Error)) return false
  const code = "code" in error ? error.code : undefined
  return (
    (typeof code === "string" && code.startsWith("E")) ||
    error.message.startsWith("Connection terminated")
  )
}

/** Error kind for logs: SQLSTATE or Node error code, never the message. */
function kindOf(error: unknown): string {
  if (error instanceof DatabaseError) return `sqlstate=${error.code ?? "none"}`
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  )
    return `code=${error.code}`
  return `kind=${error instanceof Error ? error.name : typeof error}`
}

function logToStderr(line: string): void {
  process.stderr.write(`${line}\n`)
}
