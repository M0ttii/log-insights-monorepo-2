import { execFile } from "node:child_process"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { parseArgs, promisify } from "node:util"

import { DATASETS } from "@workspace/domain/datasets"
import type { QueryRunner } from "@workspace/domain/tool"
import { z } from "zod"

import { findWorkspaceRoot, loadConfig } from "./config.ts"
import { createDatabase, QueryFailure, QUERY_TIMEOUT_MS } from "./db.ts"
import { FileReceiptStore } from "./receipts.ts"
import { createRegistry } from "./registry.ts"
import { readReference } from "./remote.ts"

/** Local, explicit opt-in; never called by tests, CI, the loader or a tool. */
const HELP = `Usage: pnpm otel:measure [options]

Measure real public S3 data through the registered tools; no model calls.
Requires a loopback SereneDB with the full --with otel load (not samples).
  --output PATH       New evidence directory (default: .data/otel-measure/<UTC>)
  --container NAME    Optional local Docker container for read-only du measurement
  --case NAME         One case; omit for all cases (names below)
  --json-profile      Additional warm JSON EXPLAIN for exact generic I/O counters
  --help              Show help without configuration or a database connection

Cases: direct-1s, direct-10s, direct-60s, boundary-50s, reference-fulltext,
       part024-first-touch, part024-warm.
Every statement keeps the production pool's 10 s limit. Failed statements are
saved and not retried. Ctrl-C preserves partial JSONL. No index is rebuilt and
no cache setting is changed. First-touch is not claimed cold unless its source
has zero cached bytes before the case. HTTPFS bytes retain the display precision
of text EXPLAIN; footer estimates and generic JSON I/O are separate measurements.
`

const CASE_NAMES = [
  "direct-1s",
  "direct-10s",
  "direct-60s",
  "boundary-50s",
  "reference-fulltext",
  "part024-first-touch",
  "part024-warm",
] as const

type CaseName = (typeof CASE_NAMES)[number]
type Case = { name: CaseName; tool: string; input: Record<string, unknown> }

export function parseOtelMeasureArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      output: { type: "string" },
      container: { type: "string" },
      case: { type: "string" },
      "json-profile": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  })
  return z
    .object({
      output: z.string().min(1).optional(),
      container: z
        .string()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
        .optional(),
      case: z.enum(CASE_NAMES).optional(),
      "json-profile": z.boolean(),
      help: z.boolean(),
    })
    .parse(values)
}

const nullableNumber = (text: string | undefined): number | null =>
  text === undefined ? null : Number(text.replaceAll(",", ""))

/** Preserve the raw plan: pretty HTTP byte units are rounded, not exact bytes. */
export function parseOtelProfile(rows: Record<string, unknown>[]) {
  const plan = rows.map((row) => z.string().parse(row["QUERY PLAN"])).join("\n")
  const groups = [
    ...plan.matchAll(/Row Groups Scanned:\s*([\d,]+)\s*\/\s*([\d,]+)/g),
  ]
  const bytes = plan.match(/\bin:\s*([\d.]+\s*(?:bytes|[KMGTPE]i?B))/)?.[1]
  const exactBytes = bytes?.match(/^(\d+) bytes$/)?.[1]
  return {
    server_seconds: nullableNumber(plan.match(/Total Time:\s*([\d.]+)s/)?.[1]),
    httpfs: plan.includes("HTTPFS HTTP Stats")
      ? {
          bytes_in_display: bytes ?? null,
          bytes_in_exact: nullableNumber(exactBytes),
          get: nullableNumber(plan.match(/#GET:\s*([\d,]+)/)?.[1]),
          head: nullableNumber(plan.match(/#HEAD:\s*([\d,]+)/)?.[1]),
        }
      : null,
    // Multiple Parquet UNION branches print one independent k/n each.
    // Index segment row groups are absent here, never called Parquet groups.
    parquet_row_groups:
      groups.length === 0
        ? null
        : {
            scanned: groups.reduce(
              (sum, match) => sum + Number(match[1]?.replaceAll(",", "")),
              0
            ),
            total: groups.reduce(
              (sum, match) => sum + Number(match[2]?.replaceAll(",", "")),
              0
            ),
          },
    plan,
  }
}

const failure = (error: unknown) =>
  error instanceof QueryFailure
    ? { kind: error.kind, sqlstate: error.sqlstate }
    : { kind: "measurement_failed", sqlstate: null }

const CACHE_SQL = `SELECT path, count(*)::VARCHAR AS blocks,
  sum(nr_bytes)::VARCHAR AS bytes FROM sdb_external_file_cache()
  GROUP BY path ORDER BY path`
const SETTINGS_SQL = `SELECT name, value FROM duckdb_settings()
  WHERE name IN ('enable_external_file_cache', 'validate_external_file_cache',
    'external_file_cache_spill', 'http_timeout', 'http_retries',
    'http_retry_wait_ms', 'http_retry_backoff', 'memory_limit', 'threads')
  ORDER BY name`
const indexPathRow = z.object({
  db: z.string().regex(/^\d+$/),
  ns: z.string().regex(/^\d+$/),
  view: z.string().regex(/^\d+$/),
})

async function indexDisk(
  db: QueryRunner,
  container: string | undefined,
  signal: AbortSignal
) {
  if (container === undefined)
    return {
      kind: "not_measured",
      reason: "Pass --container for read-only du of the view index directory.",
    }
  try {
    const { rows } = await db.query(
      `SELECT
      (SELECT oid FROM pg_database WHERE datname = current_database())::VARCHAR AS db,
      c.relnamespace::VARCHAR AS ns, c.oid::VARCHAR AS view
      FROM pg_class c WHERE c.relname = 'otel_ref'`,
      [],
      signal
    )
    const ids = indexPathRow.parse(rows[0])
    const path = `/var/lib/serenedb/engine_search/${ids.db}/${ids.ns}/${ids.view}`
    const { stdout } = await promisify(execFile)(
      "docker",
      ["exec", container, "du", "-sk", path],
      { timeout: QUERY_TIMEOUT_MS, signal, maxBuffer: 4096 }
    )
    const kib = z.coerce
      .number()
      .int()
      .nonnegative()
      .safe()
      .parse(stdout.split(/\s/)[0])
    return {
      kind: "du_allocated",
      container,
      path,
      kib,
      bytes: kib * 1024,
      note: "Allocated disk blocks of the otel_ref view directory (its existing otel_ref_idx); not pg_indexes_size, which returns 0 for view-backed indexes.",
    }
  } catch (error) {
    return {
      kind: "not_measured",
      reason: "The bounded read-only du or OID lookup failed.",
      error: failure(error),
    }
  }
}

const countCase = (name: CaseName, from: string, to: string): Case => ({
  name,
  tool: "count_events",
  input: { dataset: "otel", from, to, group_by: ["level"], top_n: 20 },
})

function cases(reference: { window_from: string; window_to: string }): Case[] {
  return [
    countCase("direct-1s", "2025-09-23T00:01:00Z", "2025-09-23T00:01:01Z"),
    countCase("direct-10s", "2025-09-23T00:02:00Z", "2025-09-23T00:02:10Z"),
    countCase("direct-60s", "2025-09-23T00:03:00Z", "2025-09-23T00:04:00Z"),
    countCase("boundary-50s", "2025-09-23T00:29:00Z", "2025-09-23T00:29:50Z"),
    {
      name: "reference-fulltext",
      tool: "search_logs",
      input: {
        dataset: "otel",
        query: "visa cache full",
        match: "phrase",
        sort: "time_asc",
        limit: 3,
        from: reference.window_from,
        to: reference.window_to,
      },
    },
    countCase(
      "part024-first-touch",
      "2025-09-23T12:00:00Z",
      "2025-09-23T12:01:00Z"
    ),
    countCase("part024-warm", "2025-09-23T12:00:00Z", "2025-09-23T12:01:00Z"),
  ]
}

/** Numerical summaries only; raw hit messages stay in their normal tool receipts. */
function resultSummary(data: unknown) {
  const search = z
    .object({ total_matches: z.number(), hits: z.array(z.unknown()) })
    .safeParse(data)
  if (search.success)
    return {
      total_matches: search.data.total_matches,
      hits_returned: search.data.hits.length,
    }
  return z
    .object({ total: z.number(), groups: z.array(z.unknown()) })
    .parse(data)
}

/** Profiles only analytical tool statements; failure evidence is durable before rethrow. */
export function createOtelMeasurementRunner(
  db: QueryRunner,
  save: (record: Record<string, unknown>) => Promise<unknown>,
  currentCase: () => CaseName | null,
  jsonProfile: boolean
): QueryRunner {
  return {
    async query(sql, params, querySignal) {
      if (!/\bFROM\s+(?:read_parquet\s*\(|otel_ref_idx\b)/i.test(sql))
        return db.query(sql, params, querySignal)
      const started = performance.now()
      await save({ type: "statement_start", case: currentCase(), sql, params })
      try {
        const profileStarted = performance.now()
        const explained = await db.query(
          `EXPLAIN ANALYZE ${sql}`,
          params,
          querySignal
        )
        const profile = parseOtelProfile(explained.rows)
        await save({
          type: "profile",
          case: currentCase(),
          sql,
          params,
          format: "text",
          wall_ms: performance.now() - profileStarted,
          pool_query_ms: explained.durationMs,
          ...profile,
        })
        const resultStarted = performance.now()
        const result = await db.query(sql, params, querySignal)
        await save({
          type: "statement_result",
          case: currentCase(),
          result_rows: result.rows.length,
          pool_query_ms: result.durationMs,
          wall_ms: performance.now() - resultStarted,
          note: "Plain result query after text EXPLAIN; not the cold profile's duration.",
        })
        if (jsonProfile) {
          const jsonStarted = performance.now()
          const json = await db.query(
            `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
            params,
            querySignal
          )
          const plan = JSON.parse(
            json.rows
              .map((row) => z.string().parse(row["QUERY PLAN"]))
              .join("\n")
          ) as unknown
          await save({
            type: "profile",
            case: currentCase(),
            format: "json",
            wall_ms: performance.now() - jsonStarted,
            pool_query_ms: json.durationMs,
            plan,
            note: "Additional warm execution. JSON exposes exact generic io counters, not HTTP verb counters. Index segment row groups are not Parquet row groups.",
          })
        }
        return result
      } catch (error) {
        await save({
          type: "statement_failure",
          case: currentCase(),
          elapsed_ms: performance.now() - started,
          error: failure(error),
          note: "No retry of the failed statement.",
        })
        throw error
      }
    },
  }
}

async function main(): Promise<void> {
  const args = parseOtelMeasureArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  const config = loadConfig()
  if (!["localhost", "127.0.0.1", "::1"].includes(config.connection.host))
    throw new Error("Measurement requires loopback SereneDB.")
  const root = findWorkspaceRoot()
  const directory = resolve(
    root,
    args.output ??
      join(
        ".data",
        "otel-measure",
        new Date().toISOString().replaceAll(":", "-")
      )
  )
  await mkdir(dirname(directory), { recursive: true })
  await mkdir(directory, { recursive: false })
  const evidence = join(directory, "measurements.jsonl")
  await writeFile(evidence, "", { flag: "wx" })
  const save = async (record: Record<string, unknown>) =>
    appendFile(
      evidence,
      `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`
    )
  const db = createDatabase(config.connection)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  const { signal } = controller
  let currentCase: CaseName | null = null
  let failedCases = 0
  try {
    await save({
      type: "start",
      statement_timeout_ms: QUERY_TIMEOUT_MS,
      database: config.connection.database,
      port: config.connection.port,
      measurement:
        "Single local observations of explicitly named windows. Text EXPLAIN runs before the result query, so the latter is warmer. Each profile has its own wall time. No global cache reset; caches are shared server-wide. HTTPFS byte strings may be display-rounded. Footer estimates cover compressed row groups, all columns, not actual transferred bytes. No full-corpus evaluation is claimed.",
    })
    const reference = await readReference(db, signal)
    if (reference === null || reference.index_name !== "otel_ref_idx")
      throw new Error("Reference index missing.")
    const sources = await db.query(
      "SELECT file_index, url, size::VARCHAR AS bytes, etag, last_modified::VARCHAR AS last_modified, footer_rows::VARCHAR AS footer_rows, row_groups::VARCHAR AS row_groups FROM otel_sources ORDER BY file_index",
      [],
      signal
    )
    if (
      sources.rows.length !== 50 ||
      sources.rows.some(
        (row, index) => row.url !== DATASETS.otel.remote.files[index]?.url
      )
    )
      throw new Error(
        "Measurement needs all 50 real allowlisted S3 source pins, not fixtures."
      )
    await save({ type: "sources", reference, sources: sources.rows })
    await save({
      type: "settings",
      rows: (await db.query(SETTINGS_SQL, [], signal)).rows,
    })
    const manifest = await db.query(
      "SELECT data_version, external_sources FROM load_manifest",
      [],
      signal
    )
    await save({
      type: "index",
      build_time_source:
        "Loader manifest and otel_reference.build_ms; existing index not rebuilt.",
      manifest: manifest.rows,
      disk: await indexDisk(db, args.container, signal),
    })

    const measured = createOtelMeasurementRunner(
      db,
      save,
      () => currentCase,
      args["json-profile"]
    )
    const registry = createRegistry({
      db: { ...measured, timeoutMs: QUERY_TIMEOUT_MS },
      receipts: new FileReceiptStore(config.receiptsDir),
    })
    let firstTouchSucceeded = false
    for (const entry of cases(reference).filter(
      (item) => args.case === undefined || item.name === args.case
    )) {
      signal.throwIfAborted()
      currentCase = entry.name
      if (
        entry.name === "part024-warm" &&
        args.case === undefined &&
        !firstTouchSucceeded
      ) {
        await save({
          type: "case_skipped",
          case: entry.name,
          reason:
            "Previous first-touch case failed; no unchanged retry after failure.",
        })
        failedCases++
        continue
      }
      const cacheBefore = await db.query(CACHE_SQL, [], signal)
      const cacheRows = z
        .array(z.object({ path: z.string(), bytes: z.string() }))
        .parse(cacheBefore.rows)
      const part24Cached = cacheRows.some(
        (row) => row.path.endsWith("/part_024.parquet") && row.bytes !== "0"
      )
      const cacheState =
        entry.name === "part024-first-touch"
          ? part24Cached
            ? "preexisting_cache_not_cold"
            : "cold_source_no_cached_blocks"
          : entry.name === "part024-warm"
            ? part24Cached
              ? "warm_source_blocks_present"
              : "no_source_cache_not_claimed_warm"
            : "cache_state_observed_no_reset"
      await save({
        type: "case_start",
        case: entry.name,
        tool: entry.tool,
        input: entry.input,
        cache_state: cacheState,
        cache_before: cacheBefore.rows,
      })
      const started = performance.now()
      try {
        const outcome = await registry.runTool(entry.tool, entry.input, {
          client: "eval",
          signal,
        })
        if (!outcome.ok) {
          failedCases++
          await save({
            type: "case_failure",
            case: entry.name,
            elapsed_ms: performance.now() - started,
            error: outcome.error,
          })
        } else {
          if (entry.name === "part024-first-touch") firstTouchSucceeded = true
          const receipt = await new FileReceiptStore(config.receiptsDir).get(
            outcome.result.receipt.receipt_id
          )
          await save({
            type: "case_result",
            case: entry.name,
            elapsed_ms: performance.now() - started,
            result: resultSummary(outcome.result.data),
            receipt: outcome.result.receipt,
            source: receipt?.source ?? null,
            cache_after: (await db.query(CACHE_SQL, [], signal)).rows,
          })
        }
      } catch (error) {
        failedCases++
        await save({
          type: "case_failure",
          case: entry.name,
          elapsed_ms: performance.now() - started,
          error: failure(error),
        })
      }
      process.stderr.write(`otel measurement ${entry.name} saved\n`)
    }
    await save({
      type: "complete",
      failed_cases: failedCases,
      cache: (await db.query(CACHE_SQL, [], signal)).rows,
    })
    if (failedCases > 0) process.exitCode = 1
    process.stdout.write(`${evidence}\n`)
  } catch (error) {
    await save({
      type: "run_failure",
      case: currentCase,
      error: failure(error),
      aborted: signal.aborted,
    })
    throw error
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
      "Otel measurement stopped; saved JSONL is retained. Check --help, a new output path, a full --with otel load, and loopback configuration. No existing index or cache setting was changed.\n"
    )
    process.exitCode = 1
  })
}
