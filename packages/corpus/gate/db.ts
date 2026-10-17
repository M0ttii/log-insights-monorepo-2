import { readFile } from "node:fs/promises"

import type { Client, ClientConfig } from "pg"

import { openClient } from "../src/db.ts"
import { fillPlaceholders, splitSqlScript } from "../src/sql-script.ts"
import type { GateConfig } from "./config.ts"

type Row = Record<string, unknown>

export type Db = {
  client: Client
  rows: (sql: string, values?: unknown[]) => Promise<Row[]>
  /** First column of the first row; fails if the query returns no row. */
  value: (sql: string, values?: unknown[]) => Promise<unknown>
  /** Runs a SQL script from gate/sql/ statement by statement. */
  script: (file: string) => Promise<void>
  close: () => Promise<void>
}

export async function connect(
  config: GateConfig,
  overrides: Partial<ClientConfig> = {}
): Promise<Db> {
  const client = await openClient(config.connection, overrides)

  const rows = async (sql: string, values?: unknown[]) =>
    (await client.query<Row>(sql, values)).rows

  return {
    client,
    rows,
    async value(sql, values) {
      const [first] = await rows(sql, values)
      if (first === undefined) throw new Error(`No row returned: ${sql}`)
      return Object.values(first)[0]
    },
    async script(file) {
      const source = await readFile(
        new URL(`./sql/${file}`, import.meta.url),
        "utf8"
      )
      const filled = fillPlaceholders(source, {
        RAW_DIR: config.containerRawDir,
      })
      for (const statement of splitSqlScript(filled)) {
        await client.query(statement)
      }
    },
    async close() {
      await client.end()
    },
  }
}

/** SQLSTATE and message of a failed query, or null if it succeeded. */
export async function failureOf(
  run: () => Promise<unknown>
): Promise<{ code: string | undefined; message: string } | null> {
  try {
    await run()
    return null
  } catch (error) {
    if (!(error instanceof Error)) throw error
    const code =
      "code" in error && typeof error.code === "string" ? error.code : undefined
    return { code, message: error.message.split("\n")[0] ?? "" }
  }
}

export function display(value: unknown): string {
  if (value === null) return "NULL"
  if (value === undefined) return "undefined"
  if (typeof value === "string") return value
  return JSON.stringify(value)
}
