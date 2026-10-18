/**
 * SereneDB compatibility gate (technical.md § 5.2, LOG-10).
 *
 * Usage: pnpm gate [G1 G4 …] [--keep]
 *   Runs all probes, or the named ones, against the SereneDB from compose.yaml
 *   and prints expected vs observed per check. Probes on the full corpus need
 *   .data/raw/BGL.log, which `pnpm data:setup` downloads. Without it those
 *   checks are reported as skipped.
 *   --keep leaves the gate schema and fixture files for manual inspection.
 * Exit code: 0 all checks as expected, 1 at least one check differs, 2 error.
 */
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"

import { loadConfig } from "./config.ts"
import { connect, display } from "./db.ts"
import {
  timed,
  type Check,
  type Info,
  type Probe,
  type ProbeContext,
  type Skip,
} from "./probe.ts"
import { g01Driver } from "./probes/g01-driver.ts"
import { g02ReadLines } from "./probes/g02-read-lines.ts"
import { g03Idempotence } from "./probes/g03-idempotence.ts"
import { g04FullText } from "./probes/g04-full-text.ts"
import { g05Analytics } from "./probes/g05-analytics.ts"
import { g06Timeouts } from "./probes/g06-timeouts.ts"
import { g07ReadReceipts } from "./probes/g07-read-receipts.ts"
import { g08ReadOnlyRole } from "./probes/g08-read-only-role.ts"
import { g09Precursors } from "./probes/g09-precursors.ts"
import { g10PhraseFuzzy } from "./probes/g10-phrase-fuzzy.ts"
import { g11MatchRecognize } from "./probes/g11-match-recognize.ts"
import { g12IndexFunctions } from "./probes/g12-index-functions.ts"
import { g13OtelCounts } from "./probes/g13-otel-counts.ts"

const PROBES: readonly Probe[] = [
  g01Driver,
  g02ReadLines,
  g03Idempotence,
  g04FullText,
  g05Analytics,
  g06Timeouts,
  g07ReadReceipts,
  g08ReadOnlyRole,
  g09Precursors,
  g10PhraseFuzzy,
  g11MatchRecognize,
  g12IndexFunctions,
  g13OtelCounts,
]

const isSkip = (entry: Check | Skip | Info): entry is Skip => "skipped" in entry
const isInfo = (entry: Check | Skip | Info): entry is Info => "info" in entry

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const keep = args.includes("--keep")
  const wanted = args
    .filter((arg) => !arg.startsWith("--"))
    .map((arg) => arg.toUpperCase())
  const unknown = wanted.filter(
    (id) => !PROBES.some((probe) => probe.id === id)
  )
  if (unknown.length > 0) {
    console.error(`Unknown probe(s): ${unknown.join(", ")}`)
    return 2
  }
  const selected =
    wanted.length === 0
      ? PROBES
      : PROBES.filter((probe) => wanted.includes(probe.id))

  const config = loadConfig()
  const db = await connect(config)
  const bglPath = join(config.hostRawDir, "BGL.log")
  const bglLog = existsSync(bglPath) ? bglPath : null

  let bglLoad: { loadMs: number; indexMs: number } | null | undefined
  const ctx: ProbeContext = {
    config,
    db,
    bglLog,
    async loadBgl() {
      if (bglLoad !== undefined) return bglLoad
      if (bglLog === null) {
        bglLoad = null
        return null
      }
      const load = await timed(() => db.script("10_bgl_load.sql"))
      const index = await timed(() => db.script("20_bgl_index.sql"))
      bglLoad = { loadMs: load.ms, indexMs: index.ms }
      return bglLoad
    },
  }

  let failed = 0
  let skipped = 0
  try {
    const version = await db.value("SELECT version()")
    console.log(
      `SereneDB gate · ${display(version)} · ${new Date().toISOString()}`
    )
    await db.script("00_schema.sql")

    for (const probe of selected) {
      console.log(`\n## ${probe.id} · ${probe.title}`)
      const { result, ms } = await timed(() => probe.run(ctx))
      for (const entry of result) {
        if (isSkip(entry)) {
          skipped++
          console.log(`  SKIP  ${entry.skipped}`)
          continue
        }
        if (isInfo(entry)) {
          console.log(`  INFO  ${entry.info}`)
          continue
        }
        if (!entry.ok) failed++
        console.log(`  ${entry.ok ? "ok  " : "DIFF"}  ${entry.name}`)
        console.log(`        observed: ${entry.observed}`)
        if (!entry.ok) console.log(`        expected: ${entry.expected}`)
      }
      console.log(`  (${ms} ms)`)
    }
  } finally {
    if (!keep) {
      await db.script("99_drop.sql")
      await rm(join(config.hostRawDir, "gate-probe"), {
        recursive: true,
        force: true,
      })
      await rm(join(config.hostReceiptsDir, "gate-probe"), {
        recursive: true,
        force: true,
      })
    }
    await db.close()
  }

  console.log(
    `\n${failed === 0 ? "All checks as expected" : `${failed} check(s) differ`}; ${skipped} skipped.`
  )
  return failed === 0 ? 0 : 1
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
