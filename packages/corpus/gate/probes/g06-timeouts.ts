import { connect, failureOf } from "../db.ts"
import { check, equals, timed, type Probe } from "../probe.ts"

/** CPU-bound queries: MEDIUM runs about a second, HEAVY far longer (only ever cancelled). */
const MEDIUM =
  "SELECT count(*) FROM gate.g6 a, gate.g6 b WHERE (a.i * 7 + b.i) % 13 = 0"
const HEAVY =
  "SELECT count(*) FROM gate.g6 a, gate.g6 b, range(40) c WHERE (a.i * 7 + b.i + c.range) % 13 = 0"
const ACTIVE_HEAVY =
  "SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%range(40)%' AND pid <> pg_backend_pid()"

export const g06Timeouts: Probe = {
  id: "G6",
  title:
    "statement_timeout, cancellation (57014) and pool behaviour after a timeout",
  async run({ config, db }) {
    await db.rows(
      "CREATE OR REPLACE TABLE gate.g6 AS SELECT range AS i FROM range(30000)"
    )

    // 1. statement_timeout is accepted but not enforced.
    const session = await connect(config)
    let warning = ""
    session.client.on("notice", (notice) => {
      warning = notice.message ?? ""
    })
    await session.client.query("SET statement_timeout = '200ms'")
    const shown = await session.value("SHOW statement_timeout")
    const notEnforced = await timed(() =>
      failureOf(() => session.client.query(MEDIUM))
    )
    await session.close()

    // 2. Server-side cancel from a second connection: 57014, connection reusable.
    const victim = await connect(config)
    const pid = await victim.value("SELECT pg_backend_pid()")
    const timer = setTimeout(() => {
      void db.rows("SELECT pg_cancel_backend($1)", [pid])
    }, 300)
    const cancelled = await timed(() =>
      failureOf(() => victim.client.query(HEAVY))
    )
    clearTimeout(timer)
    const reusable = await victim.value("SELECT 1")
    await victim.close()

    // 3. pg's client-side query_timeout only stops waiting: the query keeps
    //    running on the server and the connection stays unusable.
    const client = await connect(config, { query_timeout: 300 })
    const clientTimeout = await failureOf(() => client.client.query(HEAVY))
    await new Promise((resolve) => setTimeout(resolve, 300))
    const stillActive = await db.value(ACTIVE_HEAVY)
    const reuseAfterClientTimeout = await failureOf(() =>
      client.client.query("SELECT 1")
    )
    await db.rows(
      "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE query LIKE '%range(40)%' AND pid <> pg_backend_pid()"
    )
    await client.close().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const afterCleanup = await db.value(ACTIVE_HEAVY)

    return [
      check(
        "SET statement_timeout warns that it is not enforced",
        "warning 'not enforced by serened'",
        warning,
        warning.includes("not enforced")
      ),
      equals("SHOW statement_timeout reports the value anyway", "200ms", shown),
      check(
        "query past statement_timeout completes instead of failing",
        "no error, runs > 200 ms",
        `${notEnforced.result?.code ?? "no error"} after ${notEnforced.ms} ms`,
        notEnforced.result === null && notEnforced.ms > 200
      ),
      check(
        "pg_cancel_backend(pid) cancels with SQLSTATE 57014",
        "57014 after ~300 ms",
        `${cancelled.result?.code ?? "no error"} after ${cancelled.ms} ms`,
        cancelled.result?.code === "57014" && cancelled.ms < 1_500
      ),
      equals("connection stays usable after a server-side cancel", 1, reusable),
      check(
        "pg query_timeout rejects on the client only",
        "Query read timeout",
        clientTimeout?.message ?? "no error",
        clientTimeout?.message === "Query read timeout"
      ),
      check(
        "query keeps running on the server after a client-side timeout",
        "1 active query",
        stillActive,
        Number(stillActive) >= 1
      ),
      check(
        "connection is unusable after a client-side timeout (must be destroyed)",
        "error on reuse",
        reuseAfterClientTimeout?.message ?? "reusable",
        reuseAfterClientTimeout !== null
      ),
      equals(
        "pg_cancel_backend cleans up the orphaned query",
        "0",
        afterCleanup
      ),
    ]
  },
}
