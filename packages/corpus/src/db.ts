import { Client, types, type ClientConfig } from "pg"

import type { Connection } from "./config.ts"

/** OIDs of TIMESTAMP and TIMESTAMPTZ. Both cross the driver as raw text (technical.md § 6.1). */
const RAW_TEXT_OIDS = new Set([1114, 1184])

const rawTimestampTypes = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (RAW_TEXT_OIDS.has(oid)) return (value: string) => value
    return format === "binary"
      ? types.getTypeParser(oid, "binary")
      : types.getTypeParser(oid, "text")
  },
} as const

/**
 * Opens one SereneDB client with the project's session contract: timestamps
 * as raw text and `SET TimeZone = 'UTC'` after connecting, because SereneDB
 * ignores a startup `options=-c TimeZone=…` (gate G1).
 */
export async function openClient(
  connection: Connection,
  overrides: Partial<ClientConfig> = {}
): Promise<Client> {
  const client = new Client({
    ...connection,
    types: rawTimestampTypes,
    ...overrides,
  })
  await client.connect()
  try {
    await client.query("SET TimeZone = 'UTC'")
  } catch (error) {
    await client.end()
    throw error
  }
  return client
}
