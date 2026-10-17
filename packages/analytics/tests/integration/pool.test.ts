/**
 * Pool limits against SereneDB: the 10 s limit and client cancellation stop
 * the query on the server (gate G6), and a run whose receipt cannot be stored
 * returns no result.
 */
import { chmod, mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"

import { defineTool, READ_ONLY_ANNOTATIONS } from "@workspace/domain/tool"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import {
  createDatabase,
  QUERY_TIMEOUT_MS,
  QueryFailure,
  type Database,
} from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry, toolEntry } from "../../src/registry.ts"
import { describeCorpus } from "../../src/tools/describe-corpus.ts"
import { loadEnv, samplesConnection, temporaryDir } from "./helpers.ts"

loadEnv()

/** CPU-bound for minutes (gate G6 HEAVY); 4242 marks it in pg_stat_activity. */
const HEAVY_SQL =
  "SELECT count(*) AS n FROM range(30000) a, range(30000) b, range(40) c WHERE (a.range * 7 + b.range + c.range) % 13 = 4242"
const ACTIVE_HEAVY =
  "SELECT count(*) AS n FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%= 4242' AND pid <> pg_backend_pid()"

/** Test helper only, never registered in the default registry. */
const slowTool = toolEntry(
  defineTool({
    name: "slow_test",
    title: "Slow test",
    version: "1.0.0",
    description: "Runs a query that outlasts the pool limit.",
    input: z.strictObject({}),
    output: z.strictObject({ n: z.string() }),
    factSpecs: [],
    annotations: READ_ONLY_ANNOTATIONS,
    async run(ctx) {
      const { rows } = await ctx.db.query(HEAVY_SQL, [], ctx.signal)
      return {
        ok: true,
        run: {
          data: { n: String(rows[0]?.n) },
          scope: {
            windows: [
              {
                dataset: "bgl",
                from: "2005-06-03T00:00:00Z",
                to: "2005-06-04T00:00:00Z",
              },
            ],
            filters: {},
          },
          population: null,
          rows_returned: rows.length,
          truncated: false,
          row_limit: null,
          notes: [],
        },
      }
    },
  })
)

let db: Database
let monitor: Database
let dir: string
const lines: string[] = []

beforeAll(async () => {
  db = createDatabase(samplesConnection(), { log: (line) => lines.push(line) })
  monitor = createDatabase(samplesConnection())
  dir = await temporaryDir("analytics-pool-")
})

afterAll(async () => {
  await db.dispose()
  await monitor.dispose()
  await chmod(dir, 0o755).catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
})

function registryWith(receiptsDir: string) {
  return createRegistry({
    db,
    receipts: new FileReceiptStore(receiptsDir),
    log: (line) => lines.push(line),
    tools: [slowTool, toolEntry(describeCorpus)],
  })
}

/** Waits until no heavy query runs on the server; returns the last count. */
async function heavyQueriesAfterSettling(): Promise<string> {
  let count = "unknown"
  for (let attempt = 0; attempt < 20; attempt++) {
    const { rows } = await monitor.query(
      ACTIVE_HEAVY,
      [],
      new AbortController().signal
    )
    count = String(rows[0]?.n)
    if (count === "0") return count
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return count
}

describe("pool", () => {
  it("never returns rows of a result SereneDB could not describe", async () => {
    // One column whose type depends on an untyped parameter: SereneDB
    // 26.10.1 describes it as `unknown` (OID 705, gate G1). The pool must
    // fail rather than hand out `{ unknown: "6" }`; a typed parameter works.
    const signal = new AbortController().signal
    const untyped = await db.query("SELECT $1 + 1 AS x", [5], signal).then(
      (result) => ({ rows: result.rows }),
      (error: unknown) => ({
        error:
          error instanceof QueryFailure
            ? { name: error.name, kind: error.kind }
            : String(error),
      })
    )
    // Either correctly described (a fixed image) or rejected, never mislabelled.
    expect([
      { rows: [{ x: 6 }] },
      { error: { name: "QueryFailure", kind: "failed" } },
    ]).toContainEqual(untyped)
    const typed = await db.query("SELECT $1::BIGINT + 1 AS x", [5], signal)
    expect(typed.rows).toEqual([{ x: "6" }])
  })

  it("cancels a query on the server after 10 s and stays usable", async () => {
    const receiptsDir = join(dir, "timeout")
    const registry = registryWith(receiptsDir)
    const started = performance.now()
    const outcome = await registry.runTool(
      "slow_test",
      {},
      {
        client: "test",
        signal: new AbortController().signal,
      }
    )
    const elapsed = performance.now() - started
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: "query_timeout",
      timeout_ms: QUERY_TIMEOUT_MS,
    })
    expect(elapsed).toBeGreaterThanOrEqual(QUERY_TIMEOUT_MS)
    expect(elapsed).toBeLessThan(QUERY_TIMEOUT_MS + 3_000)
    expect(await heavyQueriesAfterSettling()).toBe("0")
    expect(await readdir(receiptsDir).catch(() => [])).toEqual([])

    // The discarded connection is replaced; the next call succeeds.
    const next = await registry.runTool(
      "describe_corpus",
      {},
      {
        client: "test",
        signal: new AbortController().signal,
      }
    )
    expect(next.ok).toBe(true)
  }, 30_000)

  it("stops the server query when the client cancels and stores no receipt", async () => {
    const receiptsDir = join(dir, "cancel")
    const registry = registryWith(receiptsDir)
    const controller = new AbortController()
    const reason = new Error("client cancelled")
    const started = performance.now()
    const running = registry.runTool(
      "slow_test",
      {},
      { client: "mcp", signal: controller.signal }
    )
    const settled = running.catch((error: unknown) => error)
    // Positive control: the monitor query does see the heavy query while it runs.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const { rows } = await monitor.query(
      ACTIVE_HEAVY,
      [],
      new AbortController().signal
    )
    expect(String(rows[0]?.n)).toBe("1")
    controller.abort(reason)
    expect(await settled).toBe(reason)
    expect(performance.now() - started).toBeLessThan(4_000)
    expect(await heavyQueriesAfterSettling()).toBe("0")
    expect(await readdir(receiptsDir).catch(() => [])).toEqual([])
    expect(
      lines.some((line) =>
        /tool=slow_test client=mcp .*outcome=cancelled$/.test(line)
      )
    ).toBe(true)
  })

  it("returns receipt_unavailable when the receipt directory is not writable", async () => {
    const receiptsDir = join(dir, "readonly")
    await mkdir(receiptsDir)
    await chmod(receiptsDir, 0o500)
    const registry = registryWith(receiptsDir)
    const outcome = await registry.runTool(
      "describe_corpus",
      {},
      {
        client: "test",
        signal: new AbortController().signal,
      }
    )
    expect(outcome.ok ? null : outcome.error.code).toBe("receipt_unavailable")
    await chmod(receiptsDir, 0o755)
    expect(await readdir(receiptsDir)).toEqual([])
  })
})
