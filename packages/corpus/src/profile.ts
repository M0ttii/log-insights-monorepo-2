/**
 * `pnpm data:profile [name …] [--samples]` (U03, LOG-12).
 *
 * Runs the read-only profiling queries in sql/profiling/ against the loaded
 * corpus and prints every result as a table. The decisions in concept.md and
 * technical.md cite these results; the queries are not part of data:setup.
 *
 * Each query in a file starts with a line `-- @ <title>`; the comment lines
 * after it explain the query. `name` selects files whose name contains it
 * (e.g. `levels`); without a name every file runs.
 *
 *   (default)   the full corpus in SERENEDB_DATABASE
 *   --samples   the Loghub 2k samples in log_insights_samples
 *   --wide      print cells in full instead of cutting them at 120 characters
 *
 * Exit code: 0 done, 2 error.
 */
import { readdir, readFile } from "node:fs/promises"

import { connectionFromEnv } from "./config.ts"
import { openClient } from "./db.ts"
import { profilingQueries } from "./profiling-queries.ts"
import { SAMPLES_DATABASE } from "./sources.ts"

const PROFILING_DIR = new URL("../sql/profiling/", import.meta.url)
const MAX_CELL = 120

function cell(value: unknown, wide: boolean): string {
  const text =
    value === null
      ? "NULL"
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value)
  const flat = text.replaceAll(/\s+/g, " ")
  return !wide && flat.length > MAX_CELL
    ? `${flat.slice(0, MAX_CELL - 1)}…`
    : flat
}

function printTable(
  rows: ReadonlyArray<Record<string, unknown>>,
  wide: boolean
): void {
  const first = rows[0]
  if (first === undefined) {
    console.log("  (no rows)")
    return
  }
  const columns = Object.keys(first)
  const cells = rows.map((row) =>
    columns.map((column) => cell(row[column], wide))
  )
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((line) => (line[index] ?? "").length))
  )
  const format = (line: readonly string[]) =>
    "  " +
    line
      .map((value, index) => value.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd()
  console.log(format(columns))
  console.log(format(widths.map((width) => "-".repeat(width))))
  for (const line of cells) console.log(format(line))
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const samples = args.includes("--samples")
  const wide = args.includes("--wide")
  const filters = args.filter((arg) => !arg.startsWith("--"))
  const files = (await readdir(PROFILING_DIR))
    .filter((name) => name.endsWith(".sql"))
    .filter(
      (name) =>
        filters.length === 0 || filters.some((filter) => name.includes(filter))
    )
    .toSorted()
  if (files.length === 0) {
    console.error(`No profiling file matches ${filters.join(", ")}`)
    return 2
  }

  const base = connectionFromEnv()
  const client = await openClient({
    ...base,
    database: samples ? SAMPLES_DATABASE : base.database,
  })
  try {
    const manifest = await client.query<{ data_version: string }>(
      "SELECT data_version FROM load_manifest"
    )
    console.log(
      `data_version ${manifest.rows[0]?.data_version ?? "missing"} in database ${client.database ?? ""}`
    )
    for (const file of files) {
      const text = await readFile(new URL(file, PROFILING_DIR), "utf8")
      console.log(`\n== ${file}`)
      for (const query of profilingQueries(text)) {
        console.log(`\n-- ${query.title}`)
        const start = performance.now()
        const result = await client.query<Record<string, unknown>>(query.sql)
        printTable(result.rows, wide)
        console.log(
          `  (${result.rows.length} rows, ${((performance.now() - start) / 1000).toFixed(1)} s)`
        )
      }
    }
    return 0
  } finally {
    await client.end()
  }
}

main().then(
  (code) => {
    process.exitCode = code
    return code
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 2
  }
)
