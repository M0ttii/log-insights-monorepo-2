import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { findWorkspaceRoot, loadConfig } from "./config.ts"
import { createDatabase } from "./db.ts"
import {
  performanceOptionsSchema,
  runPerformanceReport,
  type PerformanceReport,
} from "./performance.ts"

const HELP = `Usage: pnpm report:perf [options]

Summarize successful saved receipts with SereneDB; no model calls.
  --receipts-dir PATH   Host snapshot directory (default: configured receipts)
  --from UTC            Receipt creation time, inclusive
  --to UTC              Receipt creation time, exclusive
  --max-receipts N      Hard source limit, 1..10000 (default: 10000)
  --max-groups N        Hard group limit, 1..1000 (default: 200)
  --output PATH        Create a NEW directory with report.json and report.md
  --json               Print JSON instead of Markdown
  --help               Show this help without database configuration

Paths are relative to the repository root. Selected receipts must also exist
unchanged in the database container's fixed /data/receipts mount. A host snapshot
selects receipt IDs; it does not upload files. Existing output is never replaced.
`

export function parsePerformanceArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      "receipts-dir": { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      "max-receipts": { type: "string" },
      "max-groups": { type: "string" },
      output: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  })
  return values
}

function cell(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("`", "&#96;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll(/\r?\n/g, " ")
}

/** Only formats the values already computed by SereneDB. */
export function performanceMarkdown(report: PerformanceReport): string {
  const lines = [
    "# Observed receipt database timings",
    "",
    report.measurement,
    "",
    `Status: ${report.status}; reason: ${report.reason ?? "none"}; n: ${report.n ?? "not measured"}.`,
    "",
    report.date_window === null
      ? "Receipt creation window: not measured."
      : `Receipt creation window (UTC): ${report.date_window.first_created_at} through ${report.date_window.last_created_at}.`,
    "",
    "| Data version | Tool | Tool version | Client | n | Median ms | p95 ms | Min ms | Max ms | First receipt UTC | Last receipt UTC |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ...report.groups.map(
      (group) =>
        `| ${[
          group.data_version,
          group.tool,
          group.tool_version,
          group.client,
          group.n,
          group.median_ms,
          group.p95_ms,
          group.min_ms,
          group.max_ms,
          group.date_window.first_created_at,
          group.date_window.last_created_at,
        ]
          .map(cell)
          .join(" | ")} |`
    ),
    "",
    ...report.caveats.map((caveat) => `- ${cell(caveat)}`),
    "",
    "## Source snapshot",
    "",
    "The companion report.json preserves the exact SQL, bound parameters, filters, source signatures and result digests. SHA-256 below identifies each complete source file; re-running needs those unchanged receipts in the fixed database mount.",
    "",
    "| Receipt file | SHA-256 |",
    "| --- | --- |",
    ...report.sources.map(
      (source) => `| ${cell(source.filename)} | ${source.sha256} |`
    ),
    "",
  ]
  return lines.join("\n")
}

/** Exclusive directory creation prevents replacement of a prior report. */
export async function writePerformanceReport(
  directory: string,
  report: PerformanceReport
): Promise<void> {
  await mkdir(dirname(directory), { recursive: true })
  await mkdir(directory)
  await writeFile(
    resolve(directory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx" }
  )
  await writeFile(
    resolve(directory, "report.md"),
    performanceMarkdown(report),
    {
      flag: "wx",
    }
  )
}

async function main(): Promise<void> {
  const args = parsePerformanceArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  const config = loadConfig()
  const root = findWorkspaceRoot()
  const options = performanceOptionsSchema.parse({
    receipts_dir:
      args["receipts-dir"] === undefined
        ? config.receiptsDir
        : resolve(root, args["receipts-dir"]),
    from: args.from,
    to: args.to,
    max_receipts:
      args["max-receipts"] === undefined
        ? undefined
        : Number(args["max-receipts"]),
    max_groups:
      args["max-groups"] === undefined ? undefined : Number(args["max-groups"]),
  })
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  const db = createDatabase(config.connection)
  try {
    const report = await runPerformanceReport(db, options, controller.signal)
    controller.signal.throwIfAborted()
    if (args.output !== undefined) {
      await writePerformanceReport(resolve(root, args.output), report)
    }
    process.stdout.write(
      args.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : performanceMarkdown(report)
    )
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
    await db.dispose()
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    process.stderr.write(
      "Performance report failed. Check --help, database configuration, unchanged mounted receipts and a new output directory; no existing report is replaced. A failed write may leave a partial directory.\n"
    )
    process.exitCode = 1
  })
}
