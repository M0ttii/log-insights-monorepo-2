/**
 * `pnpm data:setup [--samples]` (technical.md § 7, LOG-11).
 *
 * Starts SereneDB, downloads and verifies the raw files, loads them into
 * log_events with helper tables, index and manifest, and prints the load
 * balance. Idempotent: a second run downloads nothing and yields the same
 * counts and data version.
 *
 *   (default)   BGL and OpenStack from Zenodo into SERENEDB_DATABASE
 *   --samples   Loghub 2k samples into the database log_insights_samples
 *
 * Exit code: 0 loaded, 1 a load check failed, 2 error.
 */
import {
  LoadCheckFailed,
  runLoad,
  type LoadCheck,
  type LoadReportRow,
  type LoadResult,
} from "./load.ts"
import { CORPUS, SAMPLES, type Source } from "./sources.ts"

const count = (value: unknown) => Number(value).toLocaleString("en-US")
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

function reasons(row: LoadReportRow): string {
  const parsed: unknown =
    typeof row.reason_counts === "string"
      ? JSON.parse(row.reason_counts)
      : row.reason_counts
  if (parsed === null || typeof parsed !== "object") return ""
  return Object.entries(parsed)
    .map(([reason, n]) => `${reason} ${count(n)}`)
    .join(", ")
}

function printChecks(checks: readonly LoadCheck[]): void {
  console.log("Checks")
  for (const check of checks) {
    console.log(`  ${check.ok ? "ok  " : "FAIL"}  ${check.check_name}`)
    console.log(`        observed: ${check.observed}`)
    if (!check.ok) console.log(`        expected: ${check.expected}`)
  }
}

function printResult(source: Source, result: LoadResult): void {
  printChecks(result.checks)

  console.log(
    `Load balance (expected line counts: ${source.expectedLinesSource})`
  )
  console.log(
    `  ${"dataset".padEnd(10)} ${"file".padEnd(28)} ${"read".padStart(10)} ${"loaded".padStart(10)} ${"rejected".padStart(9)}  reasons`
  )
  for (const row of result.report) {
    console.log(
      `  ${row.dataset.padEnd(10)} ${row.source_file.padEnd(28)} ${count(row.lines_read).padStart(10)} ` +
        `${count(row.events_loaded).padStart(10)} ${count(row.rejected).padStart(9)}  ${reasons(row)}`
    )
  }
  for (const stats of result.stats) {
    const dataset = String(stats["dataset"])
    const expected =
      dataset === "bgl"
        ? source.expectedLines.bgl
        : source.expectedLines.openstack
    const read = Number(stats["lines_read"])
    const verdict =
      read === expected
        ? "matches"
        : `differs by ${count(read - expected)} lines (see reasons above)`
    console.log(
      `  ${dataset}: read ${count(read)} lines, expected ${count(expected)}: ${verdict}; ` +
        `loaded ${count(stats["events"])} events, rejected ${count(stats["rejected"])}`
    )
  }

  console.log("Corpus")
  for (const stats of result.stats) {
    const patterns = Number(stats["patterns"])
    const single = Number(stats["single_event_patterns"])
    const share = patterns === 0 ? 0 : (100 * single) / patterns
    console.log(
      `  ${String(stats["dataset"])}: ${String(stats["first_ts"])} to ${String(stats["last_ts"])}, ` +
        `${count(patterns)} patterns (draft masks), ${count(single)} single-event (${share.toFixed(1)} %)`
    )
    if (stats["api_accesses"] !== null) {
      console.log(
        `    API accesses ${count(stats["api_accesses"])}, of which without request ID ` +
          `${count(stats["api_accesses_without_request_id"])}; requests ${count(stats["requests"])}`
      )
    }
  }

  const t = result.timingsMs
  console.log(
    `Load time: bgl ${seconds(t.bgl)}, openstack ${seconds(t.openstack)} (read + parse); ` +
      `shared steps ${seconds(t.shared)} incl. index ${seconds(t.index)}; total ${seconds(t.total)}`
  )
  console.log(
    `data_version ${result.dataVersion} in database ${result.database}`
  )
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const unknown = args.filter((arg) => arg !== "--samples")
  if (unknown.length > 0) {
    console.error(
      `Unknown argument(s): ${unknown.join(" ")}; usage: pnpm data:setup [--samples]`
    )
    return 2
  }
  const source = args.includes("--samples") ? SAMPLES : CORPUS
  try {
    const result = await runLoad(source, (message) => console.log(message))
    printResult(source, result)
    return 0
  } catch (error) {
    if (error instanceof LoadCheckFailed) {
      printChecks(error.checks)
      console.error(error.message)
      return 1
    }
    throw error
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
