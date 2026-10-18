/**
 * `pnpm data:setup [--samples] [--with <id,…|all>]` (technical.md § 7, § 7.1).
 *
 * Starts SereneDB, downloads and verifies the raw files, loads them into
 * log_events with helper tables, index and manifest, and prints the load
 * balance. Idempotent: a second run downloads nothing and yields the same
 * counts and data version.
 *
 *   (default)   BGL and OpenStack from Zenodo into SERENEDB_DATABASE
 *   --samples   Loghub 2k samples into the database log_insights_samples
 *   --with …    additionally the named extension datasets (hdfs, openssh,
 *               apache, linux, zookeeper or all); with --samples into
 *               log_insights_samples_ext. otel (remote OpenTelemetry Parquet,
 *               LOG-35) is never part of all: --with otel pins the remote
 *               files by HEAD and indexes the reference window; with
 *               --samples it reads committed fixtures into
 *               log_insights_samples_otel. Every load replaces the previous
 *               one, so name every dataset you want.
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
import { parseArgs } from "./args.ts"
import { buildSource, datasetLoad, type Source } from "./sources.ts"
import { VERSIONS } from "./versions.ts"

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

  console.log("Load balance")
  console.log(
    `  ${"dataset".padEnd(10)} ${"file".padEnd(28)} ${"read".padStart(10)} ${"loaded".padStart(10)} ${"rejected".padStart(9)}  reasons`
  )
  for (const row of result.report) {
    console.log(
      `  ${row.dataset.padEnd(10)} ${row.source_file.padEnd(28)} ${count(row.lines_read).padStart(10)} ` +
        `${count(row.events_loaded).padStart(10)} ${count(row.rejected).padStart(9)}  ${reasons(row)}`
    )
  }
  const tableStats = result.stats.filter((stats) =>
    source.datasets.some((entry) => entry.dataset === String(stats["dataset"]))
  )
  for (const stats of tableStats) {
    const dataset = String(stats["dataset"])
    const load = source.datasets.find((entry) => entry.dataset === dataset)
    if (load === undefined) throw new Error(`unexpected dataset ${dataset}`)
    const expected = datasetLoad(source, load.dataset).expectedLines
    const read = Number(stats["lines_read"])
    const verdict =
      read === expected
        ? "matches"
        : `differs by ${count(read - expected)} lines (see reasons above)`
    console.log(
      `  ${dataset}: read ${count(read)} lines, expected ${count(expected)} (${load.expectedLinesSource}): ${verdict}; ` +
        `loaded ${count(stats["events"])} events, rejected ${count(stats["rejected"])}`
    )
  }

  for (const remote of result.external) {
    const reference = remote.reference
    console.log(
      `  ${remote.dataset} (${remote.kind}): ${count(remote.files)} files, ${count(remote.footer_rows)} footer rows (incl. boundary duplicates), ${count(remote.bytes)} bytes, not loaded`
    )
    console.log(
      `    reference window [${String(reference["window_from"])}, ${String(reference["window_to"])}) over ${String(reference["source_glob"])}: ` +
        `${count(reference["events"])} events indexed, ${count(reference["duplicates_removed"])} boundary duplicate(s) removed; ` +
        `index ${String(reference["index_name"])} built in ${seconds(remote.index_ms)}` +
        (remote.index_disk_kib === null
          ? ""
          : `, ${count(remote.index_disk_kib)} KiB on disk`)
    )
  }

  console.log("Corpus")
  for (const stats of tableStats) {
    const patterns = Number(stats["patterns"])
    const single = Number(stats["single_event_patterns"])
    const share = patterns === 0 ? 0 : (100 * single) / patterns
    console.log(
      `  ${String(stats["dataset"])}: ${String(stats["first_ts"])} to ${String(stats["last_ts"])}, ` +
        `${count(patterns)} patterns (masks ${VERSIONS.patternRules}), ${count(single)} single-event (${share.toFixed(1)} %)`
    )
    if (stats["api_accesses"] !== null) {
      console.log(
        `    API accesses ${count(stats["api_accesses"])}, of which without request ID ` +
          `${count(stats["api_accesses_without_request_id"])}; requests ${count(stats["requests"])}`
      )
    }
  }

  const t = result.timingsMs
  const perDataset = source.datasets
    .map(({ dataset }) => `${dataset} ${seconds(t[dataset] ?? 0)}`)
    .join(", ")
  console.log(
    `Load time: ${perDataset} (read + parse); ` +
      `shared steps ${seconds(t.shared)} incl. index ${seconds(t.index)}; total ${seconds(t.total)}`
  )
  console.log(
    `data_version ${result.dataVersion} in database ${result.database}`
  )
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === "string") {
    console.error(parsed)
    return 2
  }
  const source = buildSource(
    parsed.samples ? "samples" : "corpus",
    parsed.extensions,
    parsed.external
  )
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
