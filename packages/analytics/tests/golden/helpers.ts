/** Author: Codex root, independent LOG-13 verifier (not a tool implementer). */
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

import type { ToolResult } from "@workspace/domain/tool"
import { Client, types } from "pg"
import { expect } from "vitest"
import { z } from "zod"

import { findWorkspaceRoot, loadConfig } from "../../src/config.ts"
import { createDatabase } from "../../src/db.ts"
import { FileReceiptStore } from "../../src/receipts.ts"
import { createRegistry } from "../../src/registry.ts"

export const integer = z
  .union([z.string().regex(/^-?\d+$/), z.number().int()])
  .transform((value) => BigInt(value))
  .refine(
    (value) =>
      value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER),
    "Integer outside exact JavaScript range"
  )
  .transform(Number)

/** Decimal comparisons allow 1e-9 absolute plus 1e-9 relative error. */
export function expectClose(actual: number | null, expected: number | null) {
  if (actual === null || expected === null) expect(actual).toBe(expected)
  else
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
      1e-9 + 1e-9 * Math.abs(expected)
    )
}

export type GoldenHarness = Awaited<ReturnType<typeof createGoldenHarness>>

export async function createGoldenHarness() {
  const root = findWorkspaceRoot()
  const envPath = join(root, ".env")
  if (existsSync(envPath)) process.loadEnvFile(envPath)
  const config = loadConfig()
  const oracle = new Client({
    ...config.connection,
    connectionTimeoutMillis: 5000,
    types: {
      getTypeParser(oid: number) {
        return oid === 1114 || oid === 1184
          ? (value: string) => value
          : types.getTypeParser(oid, "text")
      },
    },
  })
  const db = createDatabase(config.connection)
  const receipts = new FileReceiptStore(config.receiptsDir)
  const registry = createRegistry({ db, receipts, log: () => undefined })
  let dataVersion: string
  let pid: number
  try {
    await oracle.connect()
    await oracle.query("SET TimeZone = 'UTC'")
    const version = await oracle.query(
      "SELECT data_version, source FROM load_manifest"
    )
    const manifests = z
      .array(
        z.object({
          data_version: z.string().regex(/^dv_[0-9a-f]{16}$/),
          source: z.literal("corpus"),
        })
      )
      .length(1)
      .parse(version.rows)
    dataVersion = manifests[0]?.data_version ?? ""
    const identity = await oracle.query("SELECT pg_backend_pid() AS pid")
    pid = z.object({ pid: integer }).parse(identity.rows[0]).pid
  } catch {
    await oracle.end().catch(() => undefined)
    throw new Error(
      "Golden tests require a loaded full corpus and a valid load_manifest (source=corpus). Check .env and the database; load it separately with pnpm data:setup if needed. The suite never loads or changes data."
    )
  }
  const directory = join(root, ".data", "golden")
  await mkdir(directory, { recursive: true })
  const report = join(directory, `${Date.now()}-${randomUUID()}.jsonl`)
  const record = async (entry: Record<string, unknown>) => {
    const row = {
      test: expect.getState().currentTestName ?? "preflight",
      data_version: dataVersion,
      ...entry,
    }
    await appendFile(report, `${JSON.stringify(row)}\n`)
    process.stdout.write(`[golden] ${JSON.stringify(row)}\n`)
  }
  process.stdout.write(`[golden] timing report ${report}\n`)

  return {
    dataVersion,
    receipts,
    async sql<T>(
      text: string,
      params: unknown[],
      schema: z.ZodType<T>
    ): Promise<T[]> {
      // Gate G6: query_timeout alone leaves server work running; cancel our backend.
      const started = performance.now()
      let cancellation: Promise<void> | undefined
      const timer = setTimeout(() => {
        cancellation = (async () => {
          const cancel = new Client({
            ...config.connection,
            connectionTimeoutMillis: 2000,
          })
          try {
            await cancel.connect()
            await cancel.query("SELECT pg_cancel_backend($1::INTEGER)", [pid])
          } finally {
            await cancel.end()
            await oracle.end()
          }
        })()
        void cancellation.catch(() => oracle.end().catch(() => undefined))
      }, 10_000)
      let passed = false
      try {
        const result = await oracle.query(text, params)
        if (result.fields.some((field) => field.dataTypeID === 705))
          throw new Error(
            "Golden SQL has an unknown result type; cast result parameters (gate G1)."
          )
        const rows = z.array(schema).parse(result.rows)
        passed = true
        return rows
      } finally {
        clearTimeout(timer)
        await cancellation
        await record({
          side: "golden",
          sql_digest: createHash("sha256").update(text).digest("hex"),
          elapsed_ms: performance.now() - started,
          passed,
        })
      }
    },
    async run<T>(
      name: string,
      input: unknown,
      schema: z.ZodType<T>
    ): Promise<ToolResult<T>> {
      const started = performance.now()
      const outcome = await registry.runTool(name, input, {
        client: "test",
        signal: new AbortController().signal,
      })
      if (!outcome.ok) {
        await record({
          side: "tool",
          tool: name,
          elapsed_ms: performance.now() - started,
          error: outcome.error.code,
        })
        throw new Error(`${name}: ${JSON.stringify(outcome.error)}`)
      }
      const result = {
        ...outcome.result,
        data: schema.parse(outcome.result.data),
      }
      expect(result.receipt.data_version).toBe(dataVersion)
      await record({
        side: "tool",
        tool: name,
        receipt_id: result.receipt.receipt_id,
        input: result.receipt.input,
        database_ms: result.receipt.duration_ms,
        elapsed_ms: performance.now() - started,
        result_digest: result.receipt.result_digest,
      })
      return result
    },
    async close() {
      await db.dispose()
      await oracle.end()
    },
  }
}
