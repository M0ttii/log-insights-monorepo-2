/**
 * `pnpm --filter @workspace/corpus otel:replay-fixture` (LOG-35, design D7):
 * rebuilds the committed OTLP replay fixture from the real text_bench file
 * part_000.parquet over HTTPS. Local only (network); the loader and CI never
 * run it, they read the committed file and check its SHA-256 against the
 * catalog (DATASETS.otel_replay.replay.fixture).
 *
 * SereneDB selects the records (technical.md § 5.3): every row of
 * part_000 with Timestamp in the catalog window, in file_row_number order,
 * except rows whose Body, kept attributes or (dropped) LogAttributes contain
 * an email address, a 13–19 digit number, a card-like digit group or one
 * of the words email, credit, card, cvv, password, ssn. LogAttributes are
 * never written; ResourceAttributes only for the catalog keys; Body stays
 * verbatim. Prints bytes and SHA-256 for the catalog entry.
 */
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { DATASETS } from "@workspace/domain/datasets"

import { connectionFromEnv } from "./config.ts"
import { openClient } from "./db.ts"
import { sqlString } from "./sql-script.ts"

const CORPUS_DIR = new URL("..", import.meta.url).pathname

const SENSITIVE = [
  "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
  "[0-9]{13,19}",
  "[0-9]{4}[ -][0-9]{4}[ -][0-9]{4}",
  "(?i)(email|credit|card|cvv|password|ssn)",
]

const sensitive = (expr: string) =>
  SENSITIVE.map(
    (pattern) => `regexp_matches(coalesce(${expr}, ''), ${sqlString(pattern)})`
  ).join(" OR ")

async function main(): Promise<void> {
  const { fixture } = DATASETS.otel_replay.replay
  const url = DATASETS.otel.remote.files.find(
    (file) => file.index === fixture.sourceFileIndex
  )?.url
  if (url === undefined) throw new Error("source file is not allowlisted")
  const keys = fixture.resourceKeys
  const kept = [
    '"Body"',
    '"ScopeName"',
    '"ScopeVersion"',
    '"LogAttributes"::VARCHAR',
    ...keys.map((key) => `"ResourceAttributes"[${sqlString(key)}]`),
  ]
  const sql = `SELECT file_row_number::VARCHAR AS file_row_number, epoch_ns("Timestamp")::VARCHAR AS time_unix_nano,
      "TraceId" AS trace_id, "SpanId" AS span_id, "TraceFlags"::INTEGER AS trace_flags,
      "SeverityText" AS severity_text, "SeverityNumber"::INTEGER AS severity_number,
      "ServiceName" AS service_name, "Body" AS body, "ScopeName" AS scope_name, "ScopeVersion" AS scope_version,
      ${keys.map((key, i) => `"ResourceAttributes"[${sqlString(key)}] AS r${i}`).join(", ")}
    FROM read_parquet(${sqlString(url)}, file_row_number = true)
    WHERE "Timestamp" >= ${sqlString(fixture.from)}::TIMESTAMPTZ_NS AND "Timestamp" < ${sqlString(fixture.to)}::TIMESTAMPTZ_NS
      AND NOT (${kept.map(sensitive).join(" OR ")})
    ORDER BY file_row_number`
  const client = await openClient(connectionFromEnv())
  try {
    await client.query("SET http_timeout = 3")
    await client.query("SET http_retries = 1")
    const { rows } =
      await client.query<Record<string, string | number | null>>(sql)
    const records = rows.map((row, index) => ({
      fixture_row: index,
      file_row_number: String(row["file_row_number"]),
      time_unix_nano: String(row["time_unix_nano"]),
      trace_id: row["trace_id"],
      span_id: row["span_id"],
      trace_flags: row["trace_flags"],
      severity_text: row["severity_text"],
      severity_number: row["severity_number"],
      service_name: row["service_name"],
      body: row["body"],
      scope_name: row["scope_name"],
      scope_version: row["scope_version"],
      resource: Object.fromEntries(
        keys.flatMap((key, i) => {
          const value = row[`r${i}`]
          return value === null || value === undefined
            ? []
            : [[key, String(value)]]
        })
      ),
    }))
    const document = {
      source: url,
      selection: fixture.selection,
      records,
    }
    const text = `${JSON.stringify(document, null, 2)}\n`
    const path = join(CORPUS_DIR, fixture.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
    const sha256 = createHash("sha256").update(text).digest("hex")
    console.log(
      `${fixture.path}: ${records.length} records, ${Buffer.byteLength(text)} bytes, sha256 ${sha256}`
    )
  } finally {
    await client.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 2
})
