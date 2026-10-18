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
    // HTTPFS connects can ignore pg_cancel_backend (LOG-35 probe § 8).
    // These engine options are GLOBAL and have no serened.conf flags.
    // Bound each request's connect/read/retry chain before external reads;
    // this is not a total query limit (the analytics pool still enforces 10 s).
    await client.query("SET GLOBAL http_timeout = 3")
    await client.query("SET GLOBAL http_retries = 1")
  } catch (error) {
    await client.end()
    throw error
  }
  return client
}
