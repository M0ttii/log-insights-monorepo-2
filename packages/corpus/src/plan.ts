import { readFile } from "node:fs/promises"

import { CONTAINER_RAW_DIR } from "./config.ts"
import { joinPosix, type Source } from "./sources.ts"
import { sqlString, sqlStringList } from "./sql-script.ts"

/** Durations measured so far in a run, available to later steps' placeholders. */
export type Timings = { bgl: number; openstack: number; shared: number }

export type Step = {
  file: SqlFile
  /** Which load time the step counts towards (report per dataset, A-02/8). */
  timing: keyof Timings
  /** Bound parameters; such a file holds exactly one statement. */
  parameterised?: true
  placeholders: (timings: Timings) => Record<string, string>
}

const SQL_DIR = new URL("../sql/", import.meta.url)

/** Every file in sql/, in execution order; a test checks none is missing. */
export const SQL_FILES = [
  "01_schema.sql",
  "05_read.sql",
  "10_bgl.sql",
  "11_openstack.sql",
  "15_load_report.sql",
  "20_patterns.sql",
  "25_log_events.sql",
  "30_ownership.sql",
  "40_stats.sql",
  "50_index.sql",
  "90_checks.sql",
  "95_manifest.sql",
  "99_cleanup.sql",
] as const

export type SqlFile = (typeof SQL_FILES)[number]

const container = (path: string) => joinPosix(CONTAINER_RAW_DIR, path)

/** Empty set with the same shape as a read of the labels file. */
const NO_LABELS = "(SELECT NULL::VARCHAR AS line WHERE false)"

const none = () => ({})

const readLines = (path: string) =>
  `read_csv(${sqlString(container(path))}, columns = {'line': 'VARCHAR'}, ` +
  `delim = E'\\x1f', quote = '', escape = '', header = false, auto_detect = false)`

/**
 * The load steps of a source up to and including the checks. The manifest
 * (95) and cleanup (99) run separately after the checks have passed.
 */
export function loadSteps(source: Source): Step[] {
  const labelsAvailable = source.openstackLabels === null ? "false" : "true"
  const labels =
    source.openstackLabels === null
      ? NO_LABELS
      : readLines(source.openstackLabels)
  return [
    { file: "01_schema.sql", timing: "shared", placeholders: none },
    {
      file: "05_read.sql",
      timing: "bgl",
      placeholders: () => ({
        DATASET: "bgl",
        FILES: sqlStringList([container(source.bglLog)]),
      }),
    },
    { file: "10_bgl.sql", timing: "bgl", placeholders: none },
    {
      file: "05_read.sql",
      timing: "openstack",
      placeholders: () => ({
        DATASET: "openstack",
        FILES: sqlStringList(source.openstackLogs.map(container)),
      }),
    },
    {
      file: "11_openstack.sql",
      timing: "openstack",
      placeholders: () => ({
        OPENSTACK_LABELS: labels,
        OPENSTACK_LABELS_AVAILABLE: labelsAvailable,
      }),
    },
    {
      file: "15_load_report.sql",
      timing: "shared",
      placeholders: (timings) => ({
        BGL_LOAD_S: (timings.bgl / 1000).toFixed(3),
        OPENSTACK_LOAD_S: (timings.openstack / 1000).toFixed(3),
      }),
    },
    { file: "20_patterns.sql", timing: "shared", placeholders: none },
    { file: "25_log_events.sql", timing: "shared", placeholders: none },
    { file: "30_ownership.sql", timing: "shared", placeholders: none },
    {
      file: "40_stats.sql",
      timing: "shared",
      placeholders: () => ({ OPENSTACK_LABELS_AVAILABLE: labelsAvailable }),
    },
    { file: "50_index.sql", timing: "shared", placeholders: none },
    { file: "90_checks.sql", timing: "shared", placeholders: none },
  ]
}

export async function readSql(file: SqlFile): Promise<string> {
  return readFile(new URL(file, SQL_DIR), "utf8")
}
